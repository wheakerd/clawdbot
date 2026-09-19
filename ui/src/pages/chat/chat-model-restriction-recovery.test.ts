/* @vitest-environment jsdom */

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { AgentRuntimeRestrictionErrorDetails } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SessionsPatchResult } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import {
  getPendingChatPickerPatch,
  retireChatModelSelectionOwnership,
  switchChatModel,
} from "./chat-session.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const recovery = {
  action: "use-native-permissions",
  sessionId: "original-incarnation",
  lifecycleRevision: "original-revision",
  expectedPermissionMode: "guarded",
  expectedSandboxMode: null,
  expectedNativeRuntimeConsent: null,
} satisfies NonNullable<AgentRuntimeRestrictionErrorDetails["recovery"]>;

function fixture(
  options: {
    details?: Partial<AgentRuntimeRestrictionErrorDetails>;
    scopes?: string[];
    rejectRecovery?: boolean;
    unrestricted?: boolean;
    send?: boolean;
  } = {},
) {
  const result = createSessionsListResult({ model: "original", modelProvider: "fixture" });
  result.sessions[0] = {
    ...result.sessions[0],
    key: "global",
    kind: "direct",
    updatedAt: 1,
    sessionId: recovery.sessionId,
    permissionMode: "guarded",
    ...(options.send ? { agentRuntime: { id: "opencode", source: "session-key" as const } } : {}),
  };
  const details: AgentRuntimeRestrictionErrorDetails = {
    code: "AGENT_RUNTIME_RESTRICTED",
    runtimeId: "opencode",
    runtimeLabel: "OpenCode",
    reason: "sandbox",
    recovery,
    ...options.details,
  };
  let patches = 0;
  const receipt: SessionsPatchResult = {
    ok: true,
    key: "global",
    path: "",
    entry: { sessionId: recovery.sessionId, permissionMode: "full", updatedAt: 2 },
    resolved: { model: "selected", modelProvider: "fixture" },
  };
  const host = makeChatHost({
    sessionKey: "global",
    assistantAgentId: "selected-agent",
    agentsList: { defaultId: "main", scope: "global", agents: [{ id: "selected-agent" }] },
    hello: sessionMutationGatewayHello(options.scopes),
    sessionsResult: result,
    chatMessage: "Keep this draft; never replay it",
    currentSessionId: recovery.sessionId,
    requestHandlers: {
      "sessions.list": result,
      "sessions.patch": () => {
        patches += 1;
        if (patches === 1 && !options.unrestricted && !options.send) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Native runtime restricted",
            details,
          });
        }
        if (options.rejectRecovery) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Session changed; select the model again",
          });
        }
        return options.unrestricted
          ? { ...receipt, entry: { ...receipt.entry, permissionMode: "guarded" } }
          : receipt;
      },
      "chat.send": () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Admission refused",
          details,
        });
      },
    },
  });
  onTestFinished(() => {
    retireChatModelSelectionOwnership(host);
    host.sessions.dispose();
  });
  return { host, receipt };
}

async function dialog() {
  await waitForFast(() => expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull());
  const modal = document.querySelector("openclaw-modal-dialog");
  if (!modal) {
    throw new Error("Expected native runtime confirmation");
  }
  return modal;
}

function click(modal: Element, label: string) {
  const button = Array.from(modal.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error("Missing confirmation action: " + label);
  }
  button.click();
}

it.each([false, true])(
  "requires explicit consent and handles a rejected recovery=%s without replay",
  async (rejectRecovery) => {
    const { host } = fixture({ rejectRecovery });
    const selection = switchChatModel(host, "fixture/selected", "global", "opencode");
    const modal = await dialog();
    expect(modal.textContent).toContain("own permissions");
    expect(modal.textContent).toContain("Gateway host");
    expect(modal.textContent).toContain("Only this chat");
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(
      1,
    );
    click(modal, "Continue for this chat");
    await expect(selection).resolves.toBe(!rejectRecovery);
    const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
    expect(patches).toHaveLength(2);
    expect(patches[1]?.[1]).toEqual({
      key: "global",
      agentId: "selected-agent",
      expectedSessionId: recovery.sessionId,
      model: "fixture/selected",
      agentRuntime: "opencode",
      nativeRuntimeConsent: "opencode",
      sandboxMode: "off",
      permissionMode: "full",
      expectedLifecycleRevision: recovery.lifecycleRevision,
      expectedPermissionMode: "guarded",
      expectedSandboxMode: null,
      expectedNativeRuntimeConsent: null,
    });
    expect(
      host.request.mock.calls.some(
        ([method]) => method === "chat.send" || method.startsWith("config."),
      ),
    ).toBe(false);
    expect(host.chatMessage).toBe("Keep this draft; never replay it");
    expect(host.chatError ?? null).toEqual(
      rejectRecovery ? expect.stringContaining("Session changed") : null,
    );
  },
);

it.each([
  {
    name: "mandatory sandbox",
    details: { reason: "sandbox-required" as const, recovery: undefined },
  },
  { name: "no feasible recovery", details: { recovery: undefined } },
  { name: "write-only operator", scopes: ["operator.write"] },
  {
    name: "different incarnation",
    details: { recovery: { ...recovery, sessionId: "replacement" } },
  },
])("does not offer a bypass for $name", async (options) => {
  const { host } = fixture(options);
  await expect(switchChatModel(host, "fixture/selected", "global", "opencode")).resolves.toBe(
    false,
  );
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(host.chatError).toContain("Choose another model");
  expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
});

it.each([
  "cancel",
  "connection",
  "epoch",
  "session",
  "agent",
  "reset",
  "authority",
  "retired",
  "newer-selection",
] as const)("does not apply confirmation after %s", async (change) => {
  const { host } = fixture();
  const selection = switchChatModel(host, "fixture/selected", "global", "opencode");
  const modal = await dialog();
  switch (change) {
    case "cancel":
      break;
    case "connection":
      host.client = createTestGatewayClient(host.request);
      break;
    case "epoch":
      host.connectionEpoch = (host.connectionEpoch ?? 0) + 1;
      break;
    case "session":
      host.sessionKey = "agent:main:other";
      break;
    case "agent":
      host.assistantAgentId = "other-agent";
      break;
    case "reset":
      host.sessionsResult!.sessions[0]!.sessionId = "replacement";
      break;
    case "authority":
      host.hello = sessionMutationGatewayHello(["operator.write"]);
      break;
    case "retired":
      retireChatModelSelectionOwnership(host);
      break;
    case "newer-selection":
      await switchChatModel(host, "fixture/newer", "global", "openclaw");
      break;
  }
  if (change === "newer-selection" || change === "retired") {
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  } else {
    click(modal, change === "cancel" ? "Cancel" : "Continue for this chat");
  }
  await expect(selection).resolves.toBe(false);
  const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
  expect(
    patches.some(([, params]) => params && typeof params === "object" && "sandboxMode" in params),
  ).toBe(false);
  expect(patches).toHaveLength(change === "newer-selection" ? 2 : 1);
  expect(host.chatMessage).toBe("Keep this draft; never replay it");
});

it("rechecks a confirmed recovery after the shared settings tail, before dispatch", async () => {
  const { host, receipt } = fixture();
  const selection = switchChatModel(host, "fixture/selected", "global", "opencode");
  const modal = await dialog();
  const held = createDeferred<SessionsPatchResult>();
  host.request.mockImplementationOnce(async () => held.promise);
  const pending = patchChatSessionSettings(
    host,
    "global",
    { thinkingLevel: "high" },
    { agentId: "selected-agent" },
  );
  await waitForFast(() =>
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(
      2,
    ),
  );
  const previousTail = getPendingChatPickerPatch(host, "global", "selected-agent");
  click(modal, "Continue for this chat");
  // Observe admission behind the held mutation before revoking UI authority.
  await waitForFast(() =>
    expect(getPendingChatPickerPatch(host, "global", "selected-agent")).not.toBe(previousTail),
  );
  host.hello = sessionMutationGatewayHello(["operator.write"]);
  held.resolve(receipt);
  await pending;
  await expect(selection).resolves.toBe(false);
  expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(2);
});

it("does not open a late refusal on a replacement connection", async () => {
  const { host } = fixture();
  const response = createDeferred<SessionsPatchResult>();
  host.request.mockImplementationOnce(() => response.promise);
  const selection = switchChatModel(host, "fixture/selected", "global", "opencode");
  host.connectionEpoch = (host.connectionEpoch ?? 0) + 1;
  response.reject(
    new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "Native runtime restricted",
      details: {
        code: "AGENT_RUNTIME_RESTRICTED",
        runtimeId: "opencode",
        runtimeLabel: "OpenCode",
        reason: "sandbox",
        recovery,
      },
    }),
  );
  await expect(selection).resolves.toBe(false);
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(host.chatError ?? null).toBeNull();
  expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
});

it("leaves an unrestricted model selection on the ordinary patch path", async () => {
  const { host } = fixture({ unrestricted: true });
  await expect(switchChatModel(host, "fixture/selected", "global", "opencode")).resolves.toBe(true);
  const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
  expect(patches).toHaveLength(1);
  expect(patches[0]?.[1]).toEqual({
    key: "global",
    agentId: "selected-agent",
    model: "fixture/selected",
    agentRuntime: "opencode",
  });
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(host.chatError ?? null).toBeNull();
});

it.each(["confirm", "cancel"] as const)(
  "preserves a refused native send and its attachment after %s without replay",
  async (action) => {
    installOutboxBrowserStorage();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const { host } = fixture({ send: true, details: { reason: "tool-policy" } });
    const dataUrl = "data:text/plain;base64,cHJlc2VydmU=";
    const attachment = registerChatAttachmentPayload({
      attachment: { id: "native-send-attachment", mimeType: "text/plain", fileName: "notes.txt" },
      file: new File(["preserve"], "notes.txt", { type: "text/plain" }),
      dataUrl,
    });
    host.chatAttachments = [attachment];
    onTestFinished(() => releaseChatAttachmentPayloads([attachment]));
    const sending = handleSendChat(host);
    const modal = await dialog();
    expect(host.chatMessage).toBe("Keep this draft; never replay it");
    expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(dataUrl);
    expect(host.chatQueue).toEqual([]);
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(
      0,
    );
    click(modal, action === "confirm" ? "Continue for this chat" : "Cancel");
    await sending;
    const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
    expect(patches).toHaveLength(action === "confirm" ? 1 : 0);
    if (action === "confirm") {
      expect(patches[0]?.[1]).toEqual({
        key: "global",
        agentId: "selected-agent",
        expectedSessionId: recovery.sessionId,
        model: "fixture/original",
        agentRuntime: "opencode",
        nativeRuntimeConsent: "opencode",
        permissionMode: "full",
        sandboxMode: "off",
        expectedLifecycleRevision: recovery.lifecycleRevision,
        expectedPermissionMode: "guarded",
        expectedSandboxMode: null,
        expectedNativeRuntimeConsent: null,
      });
    }
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.request.mock.calls.some(([method]) => method.startsWith("config."))).toBe(false);
    expect(host.chatMessage).toBe("Keep this draft; never replay it");
    expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(dataUrl);
    expect(host.chatQueue).toEqual([]);
  },
);

it.each(["newer-selection", "server-selection", "authority", "connection", "session"] as const)(
  "does not grant native send consent after %s",
  async (change) => {
    installOutboxBrowserStorage();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const { host } = fixture({ send: true, details: { reason: "workspace-only" } });
    const sending = handleSendChat(host);
    const modal = await dialog();
    switch (change) {
      case "newer-selection":
        await switchChatModel(host, "fixture/newer", "global", "openclaw");
        break;
      case "server-selection":
        host.sessionsResult!.sessions[0]!.model = "newer";
        break;
      case "authority":
        host.hello = sessionMutationGatewayHello(["operator.write"]);
        break;
      case "connection":
        host.client = createTestGatewayClient(host.request);
        break;
      case "session":
        host.sessionKey = "agent:main:other";
        break;
    }
    if (change !== "newer-selection") {
      click(modal, "Continue for this chat");
    }
    await sending;
    expect(
      host.request.mock.calls.some(
        ([method, params]) =>
          method === "sessions.patch" &&
          params != null &&
          typeof params === "object" &&
          "nativeRuntimeConsent" in params,
      ),
    ).toBe(false);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  },
);
