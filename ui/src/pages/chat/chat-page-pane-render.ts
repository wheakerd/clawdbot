import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ApplicationContext } from "../../app/context.ts";
import { nativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { PaneSessionChangeOptions } from "./chat-pane-shared.ts";
import type { RouteDraftComposerFocus } from "./route-draft-focus-handoff.ts";
import { routeDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { ChatSplitPane } from "./split-layout-types.ts";

type ChatPagePaneRenderOptions = {
  active: boolean;
  chatMessagesBySession: ChatMessageCache;
  sessionSnapshotStore: SessionSnapshotStore;
  consumedDraftData: SessionChatRouteData | null;
  context?: ApplicationContext;
  data?: SessionChatRouteData;
  draftFocus: RouteDraftComposerFocus;
  mergedChrome: boolean;
  narrow: boolean;
  navDrawerOpen: boolean;
  onboarding: boolean;
  onClosePane?: (paneId: string) => void;
  onFaceChange: (paneId: string, sessionKey: string, face: BoardFace) => void;
  onFocusPane: (paneId: string) => void;
  onOpenSplitView?: () => void;
  onPaneSessionChange: (
    paneId: string,
    sourceSessionKey: string,
    sessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => boolean;
  onSessionDeleted: (
    paneId: string,
    sessionKey: string,
    replacementSessionKey: string,
    preserveDraft?: boolean,
  ) => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  ownerKey: string;
  pane: ChatSplitPane;
  preparingSessionKey: string | null;
  sessionKeys: readonly string[];
  showGatewayPicker: boolean;
  splitMode: boolean;
  weight: number;
  visualSessionKey: string;
};

export function renderChatPagePaneCell(options: ChatPagePaneRenderOptions) {
  const nativeGateways = options.showGatewayPicker ? nativeGatewaysCapability() : null;
  const sessions = options.context?.sessions?.state.result?.sessions ?? [];
  return html`
    <div
      class="chat-split-view__cell ${
        options.splitMode && options.active ? "chat-split-view__cell--active" : ""
      } ${options.narrow && !options.active ? "chat-split-view__cell--narrow-hidden" : ""}"
      aria-current=${options.splitMode && options.active ? "true" : nothing}
      style="flex: ${options.weight} 1 0"
      @pointerdown=${() => options.onFocusPane(options.pane.id)}
      @focusin=${() => options.onFocusPane(options.pane.id)}
    >
      <div class="chat-pane-cache">
        ${repeat(
          options.sessionKeys,
          (sessionKey) => sessionKey,
          (sessionKey) => {
            const selected = areUiSessionKeysEquivalent(sessionKey, options.pane.sessionKey);
            const visible = areUiSessionKeysEquivalent(sessionKey, options.visualSessionKey);
            const preparing =
              options.preparingSessionKey !== null &&
              areUiSessionKeysEquivalent(sessionKey, options.preparingSessionKey);
            const presented = (selected || visible) && (!options.narrow || options.active);
            const interactive = selected && visible && presented;
            const active = options.active && visible;
            const draft = active
              ? routeDraft(options.data, options.consumedDraftData, sessionKey)
              : undefined;
            const resolvedKey =
              resolveSessionKey(sessionKey, options.context?.gateway?.snapshot?.hello) ||
              sessionKey;
            const title = resolveSessionDisplayName(
              resolvedKey,
              sessions.find((row) => areUiSessionKeysEquivalent(row.key, resolvedKey)),
            );
            return html`<openclaw-chat-pane
              class="chat-pane-cache__pane ${visible
                ? "chat-pane-cache__pane--visible"
                : ""} ${preparing ? "chat-pane-cache__pane--preparing" : ""} ${active
                ? "chat-pane-cache__pane--active"
                : ""} ${options.splitMode ? "chat-split-view__pane" : ""}"
