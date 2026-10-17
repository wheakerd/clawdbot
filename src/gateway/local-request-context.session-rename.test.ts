import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolAllowDenyPolicyConfig } from "../config/types.tools.js";
import {
  drainSessionToolsFixture,
  TARGET,
  withSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";
import { roleClient } from "./session-sharing.test-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// mock-isolation: Session routing uses no plugin tools and must not load ambient plugin state.
vi.mock("../agents/openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
  resolveOpenClawPluginToolsForOptionsAsync: async () => [],
}));

afterEach(drainSessionToolsFixture);

type SessionTool = ReturnType<typeof createOpenClawCodingTools>[number];
const foreignTarget = { sessionKey: TARGET, expectedSessionId: "session-tools-target-id" };
const findSessionTool = (tools: SessionTool[]) => tools.find((tool) => tool.name === "sessions");
const sessionScope = (sessionKey: string) => ({ agentId: "main", sessionKey });
const entry = (sessionKey: string) => loadSessionEntry(sessionScope(sessionKey));
const rename = (tool: SessionTool, label: string, extra: Record<string, unknown> = {}) =>
  tool.execute("rename", { action: "patch", label, ...extra });
function absent(tools: SessionTool[]) {
  expect(findSessionTool(tools)).toBeUndefined();
}
function lacks(tool: SessionTool, ...fields: string[]) {
  for (const field of fields) {
    expect(tool.parameters).not.toHaveProperty(`properties.${field}`);
  }
}
function loopback(options: Parameters<typeof resolveGatewayScopedTools>[0]) {
  return resolveGatewayScopedTools({ ...options, surface: "loopback" }).then(({ tools }) => tools);
}
function guestAuthority(
  profileId: string,
  scopes: string[],
  signal = new AbortController().signal,
) {
  return createAdmittedRunOperatorAuthority({
    profileId,
    scopes,
    signal,
    readCurrentRoleAssignment: () => "view",
    assertCurrent: () => {},
  });
}
function toolOptions(config: OpenClawConfig, sessionKey: string, sessionId: string) {
  return { config, sessionKey, sessionId, senderIsOwner: false, messageProvider: "webchat" };
}

beforeAll(() => import("./server-methods/sessions-mutations.js"));
it("renames only the creator's session without changing its running work or settings", () =>
  withSessionToolsFixture(async (cfg) => {
    const profileId = roleClient("view", "rename-guest").authenticatedUserProfile!.profileId;
    cfg.gateway!.roles!.definitions.view!.scopes = ["operator.sessions.write"];
    const sessionKey = "agent:main:dashboard:guest-rename";
    const scope = sessionScope(sessionKey);
    const original = {
      sessionId: "guest-rename-session",
      updatedAt: 1,
      visibility: "shared" as const,
      createdVia: "operator" as const,
      label: "Research notes",
      createdActor: { type: "human", source: "profile", id: profileId } as const,
      permissionMode: "workspace" as const,
      modelOverride: "model-a",
    };
    const { sessionId } = original;
    const transcript = { ...scope, sessionId };
    await upsertSessionEntryCore(scope, original);
    await appendTranscriptMessage(transcript, {
      message: { role: "user", content: "Keep researching while renaming this session." },
    });
    const history = await loadTranscriptEvents(transcript);
    const beforeRename = loadSessionEntry(scope)!;
    expect(beforeRename.createdActor).toEqual(original.createdActor);
    const controller = new AbortController();
    const operatorAuthority = guestAuthority(
      profileId,
      ["operator.sessions.write"],
      controller.signal,
    );
    await withPersonalToolTurn(
      {
        owner: { profileId, senderId: "guest", name: "Guest", operatorAuthority },
        sessionKey,
        sessionId,
      },
      async ({ operation, admittedRunContext }) => {
        const options = toolOptions(
          { ...cfg, tools: { ...cfg.tools, allow: ["sessions"] } },
          sessionKey,
          sessionId,
        );
        const tools = createOpenClawCodingTools(options);
        const tool = expectDefined(findSessionTool(tools), "guest session operation");
        expect(tool.parameters).toHaveProperty("properties.label");
        lacks(tool, "model", "archived");
        const gateway = await loopback({ ...options, cfg: options.config, admittedRunContext });
        expect(findSessionTool(gateway)?.parameters).toHaveProperty("properties.label");
        const result = await rename(tool, "Research plan");
        expect(result.details).toMatchObject({ status: "updated", sessionKey, updated: ["label"] });
        const { updatedAt: _beforeTime, ...before } = beforeRename;
        const { updatedAt: _afterTime, ...after } = loadSessionEntry(scope)!;
        expect(after).toEqual({ ...before, label: "Research plan" });
        expect(await loadTranscriptEvents(transcript)).toEqual(history);
        expect(operation.abortSignal.aborted).toBe(false);
        for (const [overrides, error] of [
          [
            { label: "Foreign", ...foreignTarget },
            "Session-scoped writes require your own session",
          ],
          [
            { label: "Stale", expectedSessionId: "replaced-session" },
            "current durable session identity",
          ],
          [{ label: "Broader", model: "model-b" }, "current operator write grant"],
          [{ archived: true }, "current operator write grant"],
        ] as const) {
          await expect(tool.execute("denied", { action: "patch", ...overrides })).rejects.toThrow(
            error,
          );
        }
        expect(entry(sessionKey)?.label).toBe("Research plan");
        expect(entry(TARGET)?.label).toBeUndefined();
        absent(
          createOpenClawCodingTools({
            ...options,
            config: { ...options.config, tools: { ...options.config.tools, deny: ["sessions"] } },
          }),
        );
        await upsertSessionEntryCore(scope, {
          ...loadSessionEntry(scope)!,
          sessionId: "replacement-session",
        });
        expect(loadSessionEntry(scope)?.sessionId).toBe("replacement-session");
        await expect(rename(tool, "Stale run rename")).rejects.toMatchObject({
          details: { reason: "session-changed" },
        });
        await expect(
          rename(tool, "Retarget", { expectedSessionId: "replacement-session" }),
        ).rejects.toThrow("current durable session identity");
        controller.abort(new Error("guest access revoked"));
        await expect(rename(tool, "Revoked rename")).rejects.toThrow(
          "Guest's access changed; ask them again",
        );
        expect(loadSessionEntry(scope)?.label).toBe("Research plan");
      },
    );
  }));

it("respects required-sandbox default and explicit tool policy", () =>
  withSessionToolsFixture(async (cfg) => {
    const profileId = roleClient("view", "sandbox-rename-guest").authenticatedUserProfile!
      .profileId;
    cfg.gateway!.roles!.definitions.view!.sandbox = "required";
    const sessionKey = "agent:main:dashboard:sandbox-rename";
    const sessionId = "sandbox-rename-session";
    await upsertSessionEntryCore(sessionScope(sessionKey), {
      sessionId,
      updatedAt: 1,
      sandbox: "required",
      visibility: "shared",
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: profileId },
    });
    const defaultsWithoutAdmission = resolveConversationCapabilityProfile({
      config: cfg,
      sessionKey,
      sessionId,
      senderIsOwner: false,
      sandboxToolPolicy: resolveSandboxConfigForAgent(cfg, "main").tools,
    });
    for (const scope of ["operator.sessions.write", "operator.write", "operator.read"] as const) {
      const scopes = [scope];
      cfg.gateway!.roles!.definitions.view!.scopes = scopes;
      const canRename = scopes[0] !== "operator.read";
      const operatorAuthority = guestAuthority(profileId, scopes);
      await withPersonalToolTurn(
        {
          owner: { profileId, senderId: "sandbox-guest", name: "Guest", operatorAuthority },
          sessionKey,
          sessionId,
        },
        async ({ admittedRunContext }) => {
          const policies: Array<[string, ToolAllowDenyPolicyConfig | undefined, boolean, boolean]> =
            [
              ["explicit addition", { alsoAllow: ["sessions"] }, true, false],
              ["explicit allow", { allow: ["sessions"] }, true, false],
              ["allow all", { allow: [] }, true, false],
              ["restrictive allow", { allow: ["read"] }, false, false],
              ["explicit deny", { alsoAllow: ["sessions"], deny: ["sessions"] }, false, false],
              ["wildcard deny", { deny: ["sessions*"] }, false, false],
              ["unrelated addition", { alsoAllow: ["read"] }, canRename, true],
              ["default", undefined, canRename, true],
            ];
          for (const [name, policy, available, renameOnly] of policies) {
            const config = { ...cfg, tools: { ...cfg.tools, sandbox: { tools: policy } } };
            const options = toolOptions(config, sessionKey, sessionId);
            const sandboxConfig = resolveSandboxConfigForAgent(config, "main");
            const workspaceDir = cfg.agents!.entries!.main!.workspace!;
            const nativeOptions = {
              ...options,
              // This catalog proof does not invoke filesystem or shell tools.
              toolConstructionPlan: {
                includeBaseCodingTools: false,
                includeShellTools: false,
                includeChannelTools: false,
                includeOpenClawTools: true,
                includePluginTools: false,
              },
              sandbox: {
                enabled: true,
                required: true as const,
                backendId: sandboxConfig.backend,
                sessionKey,
                workspaceDir,
                agentWorkspaceDir: workspaceDir,
                workspaceAccess: "none" as const,
                runtimeId: "rename-test",
                runtimeLabel: "rename-test",
                containerName: "rename-test",
                containerWorkdir: "/workspace",
                docker: sandboxConfig.docker,
                tools: sandboxConfig.tools,
                browserAllowHostControl: false,
              },
            };
            const preparedProfile = resolveConversationCapabilityProfile({
              ...options,
              sandboxToolPolicy: sandboxConfig.tools,
            });
            const catalogs = [
              ["native", createOpenClawCodingTools(nativeOptions)],
              [
                "prepared native",
                createOpenClawCodingTools({
                  ...nativeOptions,
                  conversationCapabilityProfile: preparedProfile,
                }),
              ],
              ["loopback", await loopback({ ...options, cfg: config, admittedRunContext })],
            ] as const;
            for (const [surface, tools] of catalogs) {
              const tool = findSessionTool(tools);
              expect(Boolean(tool), `${scopes[0]} ${name}: ${surface} discovery`).toBe(available);
              if (!tool) {
                continue;
              }
              if (!canRename) {
                expect(tool.parameters).not.toHaveProperty("properties.label");
                continue;
              }
              expect(tool.parameters).toHaveProperty("properties.label");
              if (renameOnly) {
                lacks(tool, "archived", "ownerType");
                for (const args of [
                  { action: "assign_owner", ownerType: "human", ownerId: profileId },
                  { action: "patch", archived: true },
                  { action: "patch", label: "Broader", model: "model-b" },
                  { action: "stop" },
                  { action: "patch", targets: [{ sessionKey }], label: "Batch" },
                ]) {
                  await expect(tool.execute("denied", args)).rejects.toThrow(
                    "only permits renaming",
                  );
                }
              } else if (scopes[0] === "operator.write") {
                expect(tool.parameters).toHaveProperty("properties.archived");
              }
              const label = `${scopes[0]} ${name} ${surface}`;
              const args: Record<string, unknown> = { action: "patch", label };
              if (name === "default" && surface === "native") {
                // Policy hooks can return arguments with prototype defaults.
                delete args.label;
                Object.setPrototypeOf(args, {
                  label,
                  icon: "book",
                  targets: [{ ...foreignTarget }],
                });
              }
              const result = await tool.execute("rename", args);
              expect(result.details).toMatchObject({ status: "updated", updated: ["label"] });
              const renamed = entry(sessionKey);
              expect([renamed?.label, renamed?.icon]).toEqual([label, undefined]);
              expect(entry(TARGET)?.label).toBeUndefined();
            }
            if (name === "default") {
              absent(await loopback({ ...options, cfg: config }));
              const { allow, deny } = sandboxConfig.tools;
              for (const overrides of [
                { senderIsOwner: true },
                { conversationCapabilityProfile: defaultsWithoutAdmission },
                { sandbox: { ...nativeOptions.sandbox, tools: { allow, deny } } },
                {
                  sandbox: {
                    ...nativeOptions.sandbox,
                    tools: { ...sandboxConfig.tools, allow: ["read"] },
                  },
                },
              ]) {
                absent(createOpenClawCodingTools({ ...nativeOptions, ...overrides }));
              }
            }
          }
        },
      );
    }
  }));
