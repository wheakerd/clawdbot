import type { ApplicationContext } from "../../app/context.ts";
import {
  SESSION_NAVIGATION_INTENT_EVENT,
  type SessionNavigationIntent,
} from "../../lib/sessions/navigation-handoff.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { clearPaneSessionHandoff, clearPaneSessionHandoffs } from "./chat-pane-shared.ts";
import {
  CHAT_TRANSCRIPT_READY_EVENT,
  type ChatTranscriptReadyDetail,
} from "./chat-transcript-ready.ts";
import type { ChatPaneElement } from "./route-draft-focus-handoff.ts";
import type { ChatSplitLayout, ChatSplitPane } from "./split-layout-types.ts";
import { findPane } from "./split-layout.ts";

const RETAINED_SESSIONS_PER_PANE = 3;
const SESSION_NAVIGATION_PREVIEW_TIMEOUT_MS = 5_000;

type ColdSessionTransition = {
  sourceSessionKey: string;
  targetSessionKey: string;
};

export type RetainedSessionPresentation = {
  phase: "content" | "preview" | "pending";
  visualSessionKey: string;
};

type RetentionHost = HTMLElement & {
  requestUpdate(): unknown;
};
type RetentionBindings = {
  context: () => ApplicationContext | undefined;
  face: () => SessionNavigationIntent["face"];
  layout: () => ChatSplitLayout;
  selectReplacement: (paneId: string, sourceSessionKey: string, sessionKey: string) => void;
};

export class ChatPageRetainedSessions {
  private readonly sessionsByPane = new Map<string, string[]>();
  private preview: (SessionNavigationIntent & { href: string; paneId: string }) | null = null;
  private previewFrame: number | undefined;
  private previewTimer: number | undefined;
  private readonly coldTransitions = new Map<string, ColdSessionTransition>();

  constructor(
    private readonly host: RetentionHost,
    private readonly bindings: RetentionBindings,
  ) {}

  connect(): void {
    window.addEventListener("popstate", this.cancelPreview);
    window.addEventListener(SESSION_NAVIGATION_INTENT_EVENT, this.handleNavigationIntent);
    this.host.addEventListener(CHAT_TRANSCRIPT_READY_EVENT, this.handleTranscriptReady);
  }

  disconnect(): void {
    // Pane disconnects stage their scoped composer packages for a later chat
    // remount. Only an explicit pane/session close is terminal.
    window.removeEventListener("popstate", this.cancelPreview);
    window.removeEventListener(SESSION_NAVIGATION_INTENT_EVENT, this.handleNavigationIntent);
    this.host.removeEventListener(CHAT_TRANSCRIPT_READY_EVENT, this.handleTranscriptReady);
    this.cancelPreview();
    this.coldTransitions.clear();
    this.sessionsByPane.clear();
  }

  settleRoute(sessionKey: string): void {
    const layout = this.bindings.layout();
    const activePane = findPane(layout, layout.activePaneId)?.pane;
    const transition = activePane ? this.coldTransitions.get(activePane.id) : undefined;
    if (
      activePane &&
      transition &&
      !areUiSessionKeysEquivalent(transition.targetSessionKey, sessionKey)
    ) {
      this.cancelColdTransition(activePane.id);
    }
    if (!this.preview) {
      return;
    }
    if (areUiSessionKeysEquivalent(this.preview.sessionKey, sessionKey)) {
      this.preview = null;
      this.clearPreviewWork();
    } else {
      this.cancelPreview();
    }
  }

  presentation(pane: ChatSplitPane): RetainedSessionPresentation {
    if (this.preview?.paneId === pane.id) {
      return { phase: "preview", visualSessionKey: this.preview.sessionKey };
    }
    const transition = this.coldTransitions.get(pane.id);
    if (!transition) {
      return { phase: "content", visualSessionKey: pane.sessionKey };
    }
    return {
      phase: "pending",
      visualSessionKey: transition.sourceSessionKey,
    };
  }

  retain(panes: readonly ChatSplitPane[]): ReadonlyMap<string, readonly string[]> {
    const paneIds = new Set(panes.map((pane) => pane.id));
    for (const paneId of this.sessionsByPane.keys()) {
      if (!paneIds.has(paneId)) {
        this.coldTransitions.delete(paneId);
        this.sessionsByPane.delete(paneId);
      }
    }
    return new Map(panes.map((pane) => [pane.id, this.retainPane(pane)]));
  }

  private retainPane(pane: ChatSplitPane): string[] {
    let retained = this.sessionsByPane.get(pane.id);
    if (!retained) {
      retained = [];
      this.sessionsByPane.set(pane.id, retained);
    }
    const previousKey = retained.at(-1);
    if (previousKey && !areUiSessionKeysEquivalent(previousKey, pane.sessionKey)) {
      const transition = this.coldTransitions.get(pane.id);
      if (
        !transition ||
        !areUiSessionKeysEquivalent(transition.targetSessionKey, pane.sessionKey)
      ) {
        this.beginColdTransition(pane.id, previousKey, pane.sessionKey);
      }
    }
    const equivalentIndex = retained.findIndex(
      (key) => key === pane.sessionKey || areUiSessionKeysEquivalent(key, pane.sessionKey),
    );
    const retainedSession =
      equivalentIndex < 0 ? pane.sessionKey : retained.splice(equivalentIndex, 1)[0]!;
    retained.push(retainedSession);
    if (retained.length > RETAINED_SESSIONS_PER_PANE) {
      // Cold targets prepare behind this source; evicting it leaves no visible pane.
      const transition = this.coldTransitions.get(pane.id);
      const visualSource = transition?.sourceSessionKey;
      const evictionIndex = visualSource
        ? retained.findIndex((key) => !areUiSessionKeysEquivalent(key, visualSource))
        : 0;
      const evictedKey = retained.splice(evictionIndex, 1)[0]!;
      this.findPane(pane.id, evictedKey)?.prepareForEviction?.();
    }
    return retained.toSorted((left, right) => left.localeCompare(right));
  }

  discardPane(paneId: string): void {
    const context = this.bindings.context();
    if (context) {
      clearPaneSessionHandoffs(context, paneId);
      context.chatAttachmentHandoff.clearPane(paneId);
    }
    this.coldTransitions.delete(paneId);
    this.sessionsByPane.delete(paneId);
  }

  readonly removeSession = (
    paneId: string,
    sessionKey: string,
    replacementSessionKey: string,
    preserveDraft = false,
  ): void => {
    const deletedPane = this.findPane(paneId, sessionKey);
    const transition = this.coldTransitions.get(paneId);
    if (transition && areUiSessionKeysEquivalent(transition.sourceSessionKey, sessionKey)) {
      this.coldTransitions.delete(paneId);
    }
    if (!preserveDraft) {
      deletedPane?.discardStagedAttachments?.();
    }
    const retained = this.sessionsByPane.get(paneId);
    const retainedIndex = retained?.findIndex((key) => areUiSessionKeysEquivalent(key, sessionKey));
    if (retained && retainedIndex !== undefined && retainedIndex >= 0) {
      retained.splice(retainedIndex, 1);
    }
    if (transition && areUiSessionKeysEquivalent(transition.targetSessionKey, sessionKey)) {
      if (this.findPane(paneId, replacementSessionKey)?.transcriptCommitted) {
        this.coldTransitions.delete(paneId);
      } else {
        transition.targetSessionKey = replacementSessionKey;
      }
    }
    const context = this.bindings.context();
    if (context && !preserveDraft) {
      clearPaneSessionHandoff(context, paneId, sessionKey);
    }
    if (
      this.preview?.paneId === paneId &&
      areUiSessionKeysEquivalent(this.preview.sessionKey, sessionKey)
    ) {
      this.cancelPreview();
    }
    const selectedSessionKey = findPane(this.bindings.layout(), paneId)?.pane.sessionKey;
    if (selectedSessionKey && areUiSessionKeysEquivalent(selectedSessionKey, sessionKey)) {
      this.bindings.selectReplacement(paneId, sessionKey, replacementSessionKey);
    } else {
      this.host.requestUpdate();
    }
  };

  private findPane(paneId: string, sessionKey: string): ChatPaneElement | undefined {
    return [...this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].find(
      (pane) =>
        pane.paneId === paneId && areUiSessionKeysEquivalent(pane.sessionKey ?? "", sessionKey),
    );
  }

  private readonly handleNavigationIntent = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    this.cancelPreview();
    const intent = event.detail as SessionNavigationIntent;
    if (intent.face !== this.bindings.face()) {
      return;
    }
    const layout = this.bindings.layout();
    const activePane = findPane(layout, layout.activePaneId)?.pane;
    if (!activePane || areUiSessionKeysEquivalent(activePane.sessionKey, intent.sessionKey)) {
      return;
    }
    const retainedPane = this.findPane(activePane.id, intent.sessionKey);
    this.beginColdTransition(activePane.id, activePane.sessionKey, intent.sessionKey);
    if (!retainedPane?.transcriptCommitted) {
      this.host.requestUpdate();
      return;
    }
    // The route remains authoritative for semantic/global ownership. Both
    // presentations stay inert until it settles; only visual ownership moves.
    const preview = {
      ...intent,
      href: window.location.href,
      paneId: activePane.id,
      sessionKey: intent.sessionKey,
    };
    this.preview = preview;
    this.host.requestUpdate();
    this.previewFrame = requestAnimationFrame(() => {
      if (this.preview !== preview) {
        return;
      }
      this.previewFrame = requestAnimationFrame(() => {
        this.previewFrame = undefined;
        if (
          this.preview === preview &&
          (window.location.href !== preview.href || !preview.commit())
        ) {
          this.cancelPreview();
        }
      });
    });
    this.previewTimer = window.setTimeout(
      this.cancelPreview,
      SESSION_NAVIGATION_PREVIEW_TIMEOUT_MS,
    );
    event.preventDefault();
  };

  private clearPreviewWork(): void {
    if (this.previewFrame !== undefined) {
      cancelAnimationFrame(this.previewFrame);
      this.previewFrame = undefined;
    }
    if (this.previewTimer !== undefined) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
    }
  }

  private readonly handleTranscriptReady = (event: CustomEvent<ChatTranscriptReadyDetail>) => {
    // The event belongs to the connected pane, not just an equivalent session key.
    const detail = event.detail;
    if (!detail || event.target !== this.findPane(detail.paneId, detail.sessionKey)) {
      return;
    }
    const transition = this.coldTransitions.get(detail.paneId);
    if (transition && areUiSessionKeysEquivalent(transition.targetSessionKey, detail.sessionKey)) {
      this.coldTransitions.delete(detail.paneId);
      this.host.requestUpdate();
    }
  };

  private beginColdTransition(
    paneId: string,
    sourceSessionKey: string,
    targetSessionKey: string,
  ): void {
    const previous = this.coldTransitions.get(paneId);
    this.coldTransitions.delete(paneId);
    if (this.findPane(paneId, targetSessionKey)?.transcriptCommitted) {
      return;
    }
    const source = previous?.sourceSessionKey ?? sourceSessionKey;
    // Only settled content is a cover. An unfinished source could otherwise
    // complete after supersession and flash beneath the newer selection.
    if (!this.findPane(paneId, source)?.transcriptCommitted) {
      return;
    }
    this.coldTransitions.set(paneId, {
      sourceSessionKey: source,
      targetSessionKey,
    });
  }

  private cancelColdTransition(paneId: string): void {
    this.coldTransitions.delete(paneId);
    this.host.requestUpdate();
  }

  private readonly cancelPreview = () => {
    const paneId = this.preview?.paneId;
    this.clearPreviewWork();
    this.preview = null;
    // The renderer restores both selection and current viewport ownership.
    if (paneId) {
      this.host.requestUpdate();
    }
  };
}
