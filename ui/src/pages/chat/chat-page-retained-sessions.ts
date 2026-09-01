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
// Sub-second cold loads stay covered; slower loads need visible progress rather than stale content.
const COLD_SESSION_LOADING_DELAY_MS = 750;

type ColdSessionTransition = {
  revealed: boolean;
  sourceSessionKey: string;
  targetSessionKey: string;
};

type RetainedSession = {
  key: string;
  pending: boolean;
};

type RetainedSessionPresentation = {
  preparingSessionKey: string | null;
  visualSessionKey: string;
};

type RetentionHost = HTMLElement & {
  requestUpdate(): unknown;
  updateComplete: Promise<unknown>;
};
type RetentionBindings = {
  context: () => ApplicationContext | undefined;
  face: () => SessionNavigationIntent["face"];
  layout: () => ChatSplitLayout;
  selectReplacement: (paneId: string, sourceSessionKey: string, sessionKey: string) => void;
};

export class ChatPageRetainedSessions {
  private readonly sessionsByPane = new Map<string, RetainedSession[]>();
  private preview: (SessionNavigationIntent & { href: string; paneId: string }) | null = null;
  private previewFrame: number | undefined;
  private previewTimer: number | undefined;
  // Split panes can prepare concurrently; each pane owns its cover and reveal timer.
  private readonly coldTransitions = new Map<string, ColdSessionTransition>();
  private readonly coldTransitionTimers = new Map<string, number>();

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
    this.sessionsByPane.clear();
    window.removeEventListener("popstate", this.cancelPreview);
    window.removeEventListener(SESSION_NAVIGATION_INTENT_EVENT, this.handleNavigationIntent);
    this.host.removeEventListener(CHAT_TRANSCRIPT_READY_EVENT, this.handleTranscriptReady);
    this.cancelPreview();
    this.clearColdTransitions();
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
    const transition = this.coldTransitions.get(pane.id);
    const preparing =
      transition && areUiSessionKeysEquivalent(transition.targetSessionKey, pane.sessionKey);
    if (!preparing) {
      return { preparingSessionKey: null, visualSessionKey: pane.sessionKey };
    }
    return {
      preparingSessionKey: transition.targetSessionKey,
      visualSessionKey: transition.revealed ? pane.sessionKey : transition.sourceSessionKey,
    };
  }

  retain(panes: readonly ChatSplitPane[]): ReadonlyMap<string, readonly string[]> {
    const paneIds = new Set(panes.map((pane) => pane.id));
    for (const paneId of this.sessionsByPane.keys()) {
      if (!paneIds.has(paneId)) {
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
    const equivalentIndex = retained.findIndex(
      ({ key }) => key === pane.sessionKey || areUiSessionKeysEquivalent(key, pane.sessionKey),
    );
    const retainedSession =
      equivalentIndex < 0
        ? { key: pane.sessionKey, pending: true }
        : retained.splice(equivalentIndex, 1)[0]!;
    retained.push(retainedSession);
    if (retained.length > RETAINED_SESSIONS_PER_PANE) {
      // Cold targets prepare behind this source; evicting it leaves no visible pane.
      const transition = this.coldTransitions.get(pane.id);
      const visualSource = transition && !transition.revealed ? transition.sourceSessionKey : null;
      const evictionIndex = visualSource
        ? retained.findIndex(({ key }) => !areUiSessionKeysEquivalent(key, visualSource))
        : 0;
      const evictedKey = retained.splice(evictionIndex, 1)[0]!.key;
      this.findPane(pane.id, evictedKey)?.prepareForEviction?.();
    }
    return retained.map(({ key }) => key).toSorted((left, right) => left.localeCompare(right));
  }

  discardPane(paneId: string): void {
    const context = this.bindings.context();
    if (context) {
      clearPaneSessionHandoffs(context, paneId);
      context.chatAttachmentHandoff.clearPane(paneId);
    }
    this.sessionsByPane.delete(paneId);
    this.clearColdTransition(paneId);
  }

  readonly removeSession = (
    paneId: string,
    sessionKey: string,
    replacementSessionKey: string,
    preserveDraft = false,
  ): void => {
    const deletedPane = this.findPane(paneId, sessionKey);
    const transition = this.coldTransitions.get(paneId);
    const removedColdSource =
      transition &&
      !transition.revealed &&
      areUiSessionKeysEquivalent(transition.sourceSessionKey, sessionKey);
    if (removedColdSource) {
      this.finishColdTransition(paneId);
    }
    if (!preserveDraft) {
      deletedPane?.discardStagedAttachments?.();
    }
    const retained = this.sessionsByPane.get(paneId);
    const retainedIndex = retained?.findIndex(({ key }) =>
      areUiSessionKeysEquivalent(key, sessionKey),
    );
    if (retained && retainedIndex !== undefined && retainedIndex >= 0) {
      retained.splice(retainedIndex, 1);
    }
    if (transition && areUiSessionKeysEquivalent(transition.targetSessionKey, sessionKey)) {
      const replacementRetained = retained?.find(({ key }) =>
        areUiSessionKeysEquivalent(key, replacementSessionKey),
      );
      if (replacementRetained && !replacementRetained.pending) {
        this.clearColdTransition(paneId);
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
    } else if (!removedColdSource) {
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
    const retainedSession = this.sessionsByPane
      .get(activePane?.id ?? "")
      ?.find(({ key }) => areUiSessionKeysEquivalent(key, intent.sessionKey));
    if (!activePane || areUiSessionKeysEquivalent(activePane.sessionKey, intent.sessionKey)) {
      return;
    }
    const previousTransition = this.coldTransitions.get(activePane.id);
    this.clearColdTransition(activePane.id);
    if (!retainedSession || retainedSession.pending) {
      const sourceSessionKey =
        previousTransition && !previousTransition.revealed
          ? previousTransition.sourceSessionKey
          : activePane.sessionKey;
      const transition = {
        revealed: false,
        sourceSessionKey,
        targetSessionKey: intent.sessionKey,
      };
      this.coldTransitions.set(activePane.id, transition);
      this.present(activePane.id, sourceSessionKey);
      this.coldTransitionTimers.set(
        activePane.id,
        window.setTimeout(
          () => this.finishColdTransition(activePane.id),
          COLD_SESSION_LOADING_DELAY_MS,
        ),
      );
      return;
    }
    this.present(activePane.id, retainedSession.key, true);
    // The route remains authoritative for semantic/global ownership. Both
    // presentations stay inert until it settles; only visual ownership moves.
    const preview = {
      ...intent,
      href: window.location.href,
      paneId: activePane.id,
      sessionKey: retainedSession.key,
    };
    this.preview = preview;
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

  private present(paneId: string, sessionKey: string, preview = false): void {
    for (const pane of this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")) {
      if (pane.paneId !== paneId) {
        continue;
      }
      const presented = areUiSessionKeysEquivalent(pane.sessionKey ?? "", sessionKey);
      pane.classList.toggle("chat-pane-cache__pane--visible", presented);
      pane.visuallyPresented = presented;
      if (preview) {
        pane.toggleAttribute("inert", true);
        continue;
      }
      pane.toggleAttribute("inert", !presented);
      pane.setAttribute("aria-hidden", presented ? "false" : "true");
      pane.presented = presented;
    }
  }

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

  private readonly handleTranscriptReady = (event: Event) => {
    // SAFETY: this listener is registered only for our typed internal transcript-ready event.
    const detail = (event as CustomEvent<ChatTranscriptReadyDetail>).detail;
    if (detail) {
      const retainedSession = this.sessionsByPane
        .get(detail.paneId)
        ?.find(({ key }) => areUiSessionKeysEquivalent(key, detail.sessionKey));
      if (retainedSession) {
        retainedSession.pending = false;
      }
    }
    const transition = detail ? this.coldTransitions.get(detail.paneId) : undefined;
    if (
      detail &&
      transition &&
      areUiSessionKeysEquivalent(transition.targetSessionKey, detail.sessionKey)
    ) {
      this.finishColdTransition(detail.paneId);
    }
  };

  private finishColdTransition(paneId: string): void {
    const transition = this.coldTransitions.get(paneId);
    if (!transition || transition.revealed) {
      return;
    }
    this.clearColdTransitionTimer(paneId);
    transition.revealed = true;
    this.host.requestUpdate();
    void this.host.updateComplete.then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (this.coldTransitions.get(paneId) === transition) {
            this.coldTransitions.delete(paneId);
            this.findPane(paneId, transition.targetSessionKey)?.classList.remove(
              "chat-pane-cache__pane--preparing",
            );
          }
        });
      });
    });
  }

  private clearColdTransitionTimer(paneId: string): void {
    const timer = this.coldTransitionTimers.get(paneId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.coldTransitionTimers.delete(paneId);
    }
  }

  private clearColdTransition(paneId: string): void {
    this.clearColdTransitionTimer(paneId);
    this.coldTransitions.delete(paneId);
  }

  private clearColdTransitions(): void {
    for (const paneId of this.coldTransitions.keys()) {
      this.clearColdTransitionTimer(paneId);
    }
    this.coldTransitions.clear();
  }

  private cancelColdTransition(paneId: string): void {
    this.clearColdTransition(paneId);
    const pane = findPane(this.bindings.layout(), paneId)?.pane;
    if (pane) {
      this.present(pane.id, pane.sessionKey);
    }
  }

  private readonly cancelPreview = () => {
    const paneId = this.preview?.paneId;
    this.clearPreviewWork();
    this.preview = null;
    const pane = paneId ? findPane(this.bindings.layout(), paneId)?.pane : undefined;
    if (pane) {
      this.present(pane.id, pane.sessionKey);
    }
  };
}
