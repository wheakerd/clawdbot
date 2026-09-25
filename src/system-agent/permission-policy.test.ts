import { describe, expect, it } from "vitest";
import { changesPermissionPolicy, isPermissionPolicyConfigPath } from "./permission-policy.js";

describe("isPermissionPolicyConfigPath", () => {
  it.each([
    "tools.exec.security",
    "tools.elevated",
    "tools.alsoAllow",
    "approvals.exec.enabled",
    "commands.ownerAllowFrom",
    "security.installPolicy",
    "agents.defaults.sandbox.mode",
    "agents.entries.research.tools.exec.ask",
    "channels.telegram.execApprovals.approvers",
    "channels.slack.accounts.work.execApprovals",
    "skills.workshop.approvalPolicy",
    // Replacing a parent rewrites the policy beneath it.
    "tools",
    "agents.entries.research",
    "channels.telegram",
    ".",
  ])("treats %s as permission policy", (path) => {
    expect(isPermissionPolicyConfigPath(path)).toBe(true);
  });

  it.each([
    "tools.web.search.provider",
    "memory.search.provider",
    "memory.search.remote.apiKey",
    "models.providers.openai.apiKey",
    "logging.level",
    "channels.telegram.botToken",
    "agents.entries.research.model",
    "skills.workshop.autonomous.mode",
    "commands.restart",
  ])("leaves %s to the session permission mode", (path) => {
    expect(isPermissionPolicyConfigPath(path)).toBe(false);
  });

  it("fails closed on a path it cannot parse", () => {
    expect(isPermissionPolicyConfigPath("tools..exec")).toBe(true);
  });
});

describe("changesPermissionPolicy", () => {
  it("covers secret refs as well as plain config writes", () => {
    expect(
      changesPermissionPolicy({
        kind: "config-set-ref",
        path: "tools.exec.security",
        source: "env",
        id: "EXEC_SECURITY",
      }),
    ).toBe(true);
    expect(changesPermissionPolicy({ kind: "gateway-restart" })).toBe(false);
  });
});
