/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-transcript-ready.test/"} */
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import {
  CHAT_TRANSCRIPT_READY_EVENT,
  type ChatTranscriptReadyDetail,
} from "./chat-transcript-ready.ts";

it("reports the first rendered message once", () => {
  const { pane, state } = createTestChatPane({
    client: {} as GatewayBrowserClient,
    sessions: {} as SessionCapability,
  });
  state.sessionKey = "agent:main:ready";
  pane.paneId = "p1";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.append(document.createElement("p"));
  pane.append(bubble);
  const ready = vi.fn();
  pane.addEventListener(CHAT_TRANSCRIPT_READY_EVENT, ready);
  // SAFETY: this fixture is the concrete chat-pane test subclass with Lit's lifecycle method.
  const lifecycle = pane as TestChatPane & { updated(): void };

  lifecycle.updated();
  lifecycle.updated();

  expect(ready).toHaveBeenCalledOnce();
  const event = ready.mock.calls[0]?.[0] as CustomEvent<ChatTranscriptReadyDetail>;
  expect(event.detail).toEqual({ paneId: "p1", sessionKey: "agent:main:ready" });
});
