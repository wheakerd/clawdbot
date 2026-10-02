import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

function createVersionFourSessionManager() {
  return {
    getHeader: () => ({ version: 4 }),
    getLeafEntry: () => undefined,
    getSessionTarget: () => undefined,
    getSessionId: () => "runtime-context-compat",
  } as unknown as ReturnType<typeof guardSessionManager>;
}

describe("runtime-context session compatibility", () => {
  it("preserves shipped version-4 carrier bytes before signed thinking", async () => {
    const legacyBody = "retained v2026.9.7 context";
    const legacyText = `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${legacyBody}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
    const legacyCarrier: AgentMessage = {
      ...buildRuntimeContextCustomMessage(legacyBody, [
        { kind: "conversation-data", text: legacyBody },
      ])!,
      content: legacyText,
      timestamp: 2,
    };
    const signedReply = makeAssistantMessageFixture({
      content: [
        { type: "thinking", thinking: "signed thought", thinkingSignature: "signature" },
        { type: "text", text: "Original answer" },
      ],
    });
    const activeSession = {
      agent: { convertToLlm, state: { messages: [] } },
    } as unknown as Pick<AgentSession, "agent">;
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      appendOnlyRuntimeContext: true,
      attempt: { sessionId: "runtime-context-compat", prompt: "Continue" },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createVersionFourSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const converted = await activeSession.agent.convertToLlm([
      { role: "user", content: "Original question", timestamp: 1 },
      legacyCarrier,
      signedReply,
      { role: "user", content: "Continue", timestamp: 4 },
    ]);

    expect(converted[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: legacyText }],
      runtimeContext: { retained: true },
      runtimeContextCarrier: true,
      runtimeContextCarrierRetained: true,
    });
    expect(converted[2]).toBe(signedReply);
  });
});
