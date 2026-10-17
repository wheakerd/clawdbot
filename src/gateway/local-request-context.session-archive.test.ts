import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import {
  setActiveEmbeddedRun,
  clearActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../agents/embedded-agent-runner/runs.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { CliDeps } from "../cli/deps.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { assignSessionOwner } from "../config/sessions/session-accessor.sqlite-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// These fixtures create no browser resources; keep unrelated browser loading out of archive proof.
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

const TARGET = "agent:main:dashboard:assigned-archive";
const TARGET_ID = "assigned-archive-id";
let fixtureRun: Promise<void> | undefined;
afterEach(async () => {
  await fixtureRun?.catch(() => {});
  fixtureRun = undefined;
});

function gatewayContext() {
  return expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "local Gateway context");
}

function toolOptions(cfg: OpenClawConfig, sessionKey = TARGET, sessionId = TARGET_ID) {
  return { config: cfg, agentId: "main", sessionKey, sessionId, senderIsOwner: false };
}

function sessionTool(tools: ReturnType<typeof createOpenClawCodingTools>, name = "sessions") {
  const found = tools.find((tool) => tool.name === name);
  return expectDefined(found, name);
}

function loopbackTools(options: ReturnType<typeof toolOptions> & { runId?: string }) {
  return resolveGatewayScopedTools({ ...options, cfg: options.config, surface: "loopback" }).then(
    ({ tools }) => tools,
  );
}

function expectActions(
  tool: ReturnType<typeof sessionTool>,
  actions: string[],
  properties: Record<string, unknown> = {},
) {
  expect(tool.parameters).toMatchObject({
    properties: { action: { enum: actions }, ...properties },
  });
}

const targetScope = { agentId: "main", sessionKey: TARGET };
const archivedAt = () => loadSessionEntry(targetScope)?.archivedAt;
function assignTarget(profileId: string) {
  const actor = { type: "human" as const, id: profileId };
  assignSessionOwner(targetScope, { owner: actor, assignedBy: actor });
}

function withSessionToolsFixture(run: (cfg: OpenClawConfig) => Promise<void>) {
  return (fixtureRun = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      tools: { sessions: { visibility: "all" } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await upsertSessionEntryCore(targetScope, {
      sessionId: TARGET_ID,
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: "other-person" },
    });
    const resources = new LegacyPluginSdkResourceHost();
    try {
      await resources.run(() =>
        withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, () =>
          run(cfg),
        ),
      );
    } finally {
      await resources.close();
    }
  }));
}

function withWriter<T>(
  client: ReturnType<typeof roleClient>,
  run: () => Promise<T>,
  scopes = ["operator.write"],
  request = expectDefined(getPluginRuntimeGatewayRequestScope(), "Gateway request scope"),
) {
  return withPluginRuntimeGatewayRequestScope({ ...request, client }, () =>
    withOperatorToolGatewayAuthority(
      { authenticatedUserProfile: client.authenticatedUserProfile, scopes },
      run,
    ),
  );
}

function seedOwnedSession(sessionKey: string, sessionId: string, profileId: string) {
  return upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    { sessionId, updatedAt: 1, createdActor: { type: "human", source: "profile", id: profileId } },
  );
}

// Keep the first Stop call's cold handler import outside its RPC deadline.
beforeAll(() => import("./server-methods/sessions-abort.js"));

it("keeps archive but withholds Stop from embedded and admitted MCP collectors", () =>
  withSessionToolsFixture(async (cfg) => {
    const client = roleClient("write");
    const runId = "collector-session-controls";
    seedSubagentRunForReadTest({ runId, childSessionKey: TARGET, collect: true });
    try {
      await withWriter(client, async () => {
        const options = { ...toolOptions(cfg), runId };
        for (const tools of [
          createOpenClawCodingTools({ ...options, swarmCollector: true }),
          await loopbackTools(options),
        ]) {
          const tool = sessionTool(tools);
          expectActions(tool, ["patch", "assign_owner"], { archived: { type: "boolean" } });
          expect(tool.parameters).not.toHaveProperty("properties.runId");
          await expect(
            tool.execute("collector-stop", { action: "stop", sessionKey: TARGET }),
          ).rejects.toThrow(/unavailable to non-interactive collectors/);
          expect(tools.some((candidate) => candidate.name === "sessions_send")).toBe(false);
        }
      });
    } finally {
      await resetSubagentRegistryForTests({ persist: false });
    }
  }));

it.each(["unbound", "reader", "session-writer"] as const)(
  "does not expose archive to a %s caller",
  (caller) =>
    withSessionToolsFixture(async (cfg) => {
      const options = toolOptions(cfg);
      const check = async () => {
        const assignment = sessionTool(createOpenClawCodingTools(options));
        expectActions(
          assignment,
          caller === "session-writer" ? ["patch", "assign_owner"] : ["assign_owner"],
        );
        expect(assignment.parameters).not.toHaveProperty("properties.archived");
        await expect(
          assignment.execute("no-archive", { action: "patch", archived: true }),
        ).rejects.toThrow(
          caller === "session-writer" ? /current operator write grant/ : /Only assign_owner/,
        );
        expect((await loopbackTools(options)).some((tool) => tool.name === "sessions")).toBe(false);
      };
      if (caller === "unbound") {
        await check();
      } else {
        const client = roleClient("view");
        const scope = caller === "session-writer" ? "operator.sessions.write" : "operator.read";
        client.connect.scopes = [scope];
        await withWriter(client, check, [scope], {
          ...getPluginRuntimeGatewayRequestScope(),
          isWebchatConnect: () => false,
        });
      }
      expect(archivedAt()).toBeUndefined();
    }),
);

it.each(["creator", "assignee", "unrelated", "replacement"] as const)(
  "stops only the authorized ordinary-session run (%s)",
  (relationship) =>
    withSessionToolsFixture(async (cfg) => {
      const context = gatewayContext();
      const client = roleClient("write");
      const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
      const requesterKey = "agent:main:dashboard:stop-requester";
      const targetKey =
        relationship === "creator" ? "agent:main:dashboard:created-stop-target" : TARGET;
      await seedOwnedSession(requesterKey, "stop-requester-id", profile.profileId);
      if (relationship === "creator") {
        await seedOwnedSession(targetKey, TARGET_ID, profile.profileId);
      } else if (relationship !== "unrelated") {
        assignTarget(profile.profileId);
      }
      const run = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: "ordinary-stop-run",
        sessionKey: targetKey,
        sessionId: TARGET_ID,
        agentId: "main",
        timeoutMs: 60_000,
      });
      run.controller.signal.addEventListener("abort", () => run.cleanup(), { once: true });
      try {
        await withWriter(client, async () => {
          const tool = sessionTool(
            createOpenClawCodingTools(toolOptions(cfg, requesterKey, "stop-requester-id")),
          );
          const stop = withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: requesterKey,
              operationalRunInstance: { instanceId: "stop-tool-instance", runId: "stop-tool-run" },
              receiptAuthority: () => true,
              gatewayContextResolver: () => context,
            },
            () =>
              tool.execute("stop-ordinary", {
                action: "stop",
                sessionKey: targetKey,
                runId: "ordinary-stop-run",
                expectedSessionId: relationship === "replacement" ? "old-session-id" : TARGET_ID,
              }),
          );
          if (relationship === "unrelated" || relationship === "replacement") {
            await expect(stop).rejects.toThrow(/creator|assigned|changed/i);
          } else {
            expect((await stop).details).toMatchObject({ ok: true });
          }
        });
        expect(run.controller.signal.aborted).toBe(
          relationship === "creator" || relationship === "assignee",
        );
      } finally {
        run.cleanup();
      }
    }),
);

it("preserves unrelated active-run steering under session-send access", () =>
  withSessionToolsFixture(async (cfg) => {
    const client = roleClient("write");
    const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
    const requesterKey = "agent:main:dashboard:steer-requester";
    await seedOwnedSession(requesterKey, "steer-requester-id", profile.profileId);
    const accepted = vi.fn();
    const legacyQueue = vi.fn(async () => {
      throw new Error("unexpected legacy queue path");
    });
    const handle: EmbeddedAgentQueueHandle = {
      runId: "ordinary-steer-run",
      queueMessage: legacyQueue,
      isStreaming: () => true,
      isCompacting: () => false,
      supportsTranscriptCommitWait: true,
      sourceReplyDeliveryMode: "automatic",
      abort: () => {},
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: async (_text, _options, assertCurrent) => {
          assertCurrent();
          accepted();
        },
      },
    };
    setActiveEmbeddedRun(TARGET_ID, handle, TARGET, undefined, "main");
    try {
      await withWriter(client, async () => {
        const tool = sessionTool(
          createOpenClawCodingTools(toolOptions(cfg, requesterKey, "steer-requester-id")),
          "sessions_send",
        );
        const result = await tool.execute("steer-ordinary", {
          mode: "steer",
          sessionKey: TARGET,
          message: "Use the updated requirements",
          timeoutSeconds: 0,
        });
        expect(result.details, JSON.stringify(result.details)).toMatchObject({
          status: "accepted",
          targetDisposition: "steered",
        });
      });
      expect(accepted).toHaveBeenCalledOnce();
      expect(legacyQueue).not.toHaveBeenCalled();
    } finally {
      clearActiveEmbeddedRun(TARGET_ID, handle);
    }
  }));

it("allows creator self-archive and denies assignee archive or restore through the assembled tool surface", () =>
  withSessionToolsFixture(async (cfg) => {
    const context = gatewayContext();
    const client = roleClient("write");
    client.connect.scopes = ["operator.write"];
    const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
    const sessionKey = "agent:main:dashboard:operator-archive";
    const sessionId = "operator-archive-id";
    await seedOwnedSession(sessionKey, sessionId, profile.profileId);
    assignTarget(profile.profileId);
    const archived = createDeferredCore();
    context.subscribeSessionEvents("operator-archive-proof");
    context.broadcastToConnIds = (event, payload) => {
      if (event === "sessions.changed" && isRecord(payload) && payload.sessionKey === sessionKey) {
        archived.resolve();
      }
    };
    const admission = await beginSessionWorkAdmission({
      scope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
    });
    let retained: ReturnType<typeof createOpenClawCodingTools>[number] | undefined;
    try {
      const result = await withWriter(client, async () => {
        const options = toolOptions(cfg, sessionKey, sessionId);
        const tools = createOpenClawCodingTools(options);
        for (const surface of [tools, await loopbackTools(options)]) {
          const tool = sessionTool(surface);
          expectActions(tool, ["patch", "stop", "assign_owner"], { archived: { type: "boolean" } });
          expect(tool.parameters).toMatchObject({ required: ["action"] });
          for (const args of [
            { action: "reset", sessionKey: TARGET },
            { action: "patch", archived: true, model: "other" },
          ]) {
            await expect(tool.execute("invalid-archive", args)).rejects.toThrow(/archive|restore/i);
          }
        }
        const tool = sessionTool(tools);
        retained = tool;
        const archiveAssigned = (value: boolean) =>
          tool.execute("archive-assigned", {
            action: "patch",
            sessionKey: TARGET,
            expectedSessionId: TARGET_ID,
            archived: value,
          });
        await expect(archiveAssigned(true)).rejects.toThrow(/session creator/i);
        expect(archivedAt()).toBeUndefined();
        await upsertSessionEntryCore(targetScope, { archivedAt: 123 });
        await expect(archiveAssigned(false)).rejects.toThrow(/session creator/i);
        expect(archivedAt()).toBe(123);
        return await admission.run(() =>
          tool.execute("archive-own-session", { action: "patch", archived: true }),
        );
      });
      expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.archivedAt).toBeUndefined();
    } finally {
      admission.release();
    }
    await archived.promise;
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
      sessionId,
      archivedAt: expect.any(Number),
    });
    await expect(
      expectDefined(retained, "retained archive tool").execute("expired-restore", {
        action: "patch",
        archived: false,
      }),
    ).rejects.toThrow(/current operator write grant/);
  }));
