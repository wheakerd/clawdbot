import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  installManagedGitHubProfile,
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  prepareWorkerGitHubBinding,
  prepareWorkerGitHubBindingGrant,
} from "./worker-github-binding.js";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn(),
  worktree: vi.fn(),
  repository: vi.fn(),
  repositoryWorkspace: vi.fn(),
  session: vi.fn(),
  nativeToken: vi.fn(),
  oauth: vi.fn(),
}));

vi.mock("../../agents/github-oauth-client.js", () => ({ verifyGitHubCredential: mocks.verify }));
vi.mock("../github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: mocks.refresh,
}));
vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: mocks.snapshot,
}));
vi.mock("../../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    findLiveByOwner: mocks.worktree,
    resolveRepositoryIdentity: mocks.repository,
  },
}));
vi.mock("../session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.session }));
vi.mock("../../state/session-repository-workspaces.js", () => ({
  getSessionRepositoryWorkspaceStore: () => ({
    prepare: async () => ({
      workspace: mocks.repositoryWorkspace(),
      current: mocks.repositoryWorkspace,
    }),
  }),
}));
vi.mock("../../agents/github-oauth-records.js", () => ({ inspectGitHubOAuthRecord: mocks.oauth }));
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: mocks.nativeToken }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const profileId = "ghp_11111111111111111111111111111111";
const token = "synthetic-worker-github-binding-token";
const session = { sessionId: "worker-session", sessionKey: "agent:main:worker", agentId: "main" };
const worktree = {
  id: "worker-worktree",
  path: "/repo/worktree",
  repoRoot: "/repo",
  repoFingerprint: "repository-fingerprint",
  branch: "openclaw/session-branch",
  ownerKind: "session",
  ownerId: session.sessionKey,
};
const verified = {
  status: "available" as const,
  account: { accountId: 42, login: "shared-bot", avatarUrl: null },
  scopes: [],
};
let config: OpenClawConfig;

async function installProfile(scope: "agent" | "system" = "system", host?: string) {
  const profileDir = resolveManagedGitHubProfileDir({ agentId: "main", scope, profileId });
  await installManagedGitHubProfile({
    profileDir,
    token,
    commitConfig: async () => {},
  });
  if (host) {
    await writeManagedGitHubProfileFiles(profileDir, {
      login: verified.account.login,
      token,
      host,
    });
  }
  mocks.verify.mockClear();
  return profileDir;
}

describe("worker GitHub launch binding", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("worker-github-binding-"));
    config = { tools: { github: { profileId, gitAuthor: { name: "Shared Bot" } } } };
    mocks.snapshot.mockReset().mockImplementation(() => ({ config, sourceConfig: config }));
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    mocks.oauth.mockReset().mockReturnValue({ state: "missing" });
    mocks.verify.mockReset().mockResolvedValue(verified);
    mocks.worktree.mockReset().mockReturnValue(worktree);
    mocks.repository.mockReset().mockResolvedValue({ originUrl: "git@github.com:owner/repo.git" });
    mocks.repositoryWorkspace.mockReset();
    mocks.session.mockReset().mockReturnValue({
      canonicalKey: session.sessionKey,
      agentId: "main",
      entry: {
        sessionId: session.sessionId,
        worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
      },
    });
    mocks.nativeToken.mockReset().mockResolvedValue({
      code: 0,
      stdout: Buffer.from(token),
      stderr: Buffer.alloc(0),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("binds the verified shared account and canonical HTTPS remote", async () => {
    await installProfile();

    await expect(prepareWorkerGitHubBinding(session)).resolves.toEqual({
      token,
      login: "shared-bot",
      branch: worktree.branch,
      remoteUrl: "https://github.com/owner/repo.git",
      gitAuthor: { name: "Shared Bot" },
    });
    expect(mocks.verify).toHaveBeenCalledWith(token, {
      apiBaseUrl: "https://api.github.com",
    });
    expect(mocks.nativeToken).not.toHaveBeenCalled();
  });

  it.each(["system", "agent"] as const)(
    "retains the selected %s account through rotation and exact profile acknowledgment",
    async (scope) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      if (scope === "agent") {
        config.agents = {
          entries: { main: { tools: { github: { profileId, gitAuthor: { name: "Agent Bot" } } } } },
        };
      }
      const selectedConfig =
        scope === "agent" ? config.agents!.entries!.main!.tools!.github! : config.tools!.github!;
      selectedConfig.kind = "oauth";
      let expiresAtMs = Date.now() + 8 * 3_600_000;
      mocks.oauth.mockImplementation(() => ({
        state: "valid",
        record: {
          accountId: verified.account.accountId,
          accessExpiresAtMs: expiresAtMs,
        },
      }));
      const profileDir = await installProfile(scope);
      const grant = await prepareWorkerGitHubBindingGrant(session);
      try {
        expect(grant?.binding).toMatchObject({
          token,
          login: verified.account.login,
          gitAuthor: { name: scope === "agent" ? "Agent Bot" : "Shared Bot" },
        });
        expect(grant?.refresh).toBeTypeOf("function");
        expect(grant?.expiresAtMs).toBe(expiresAtMs);
        const started = Date.now();
        for (let step = 1; step <= 7; step++) {
          vi.setSystemTime(started + step * 8 * 3_600_000);
          expiresAtMs = Date.now() + 8 * 3_600_000;
          const rotated = `synthetic-selected-token-${step}`;
          await writeManagedGitHubProfileFiles(profileDir, {
            login: verified.account.login,
            token: rotated,
          });
          const next = await grant?.refresh?.();
          expect(next).toMatchObject({ generation: step, token: rotated, expiresAtMs });
          expect(grant?.binding.token).toBe(
            step === 1 ? token : `synthetic-selected-token-${step - 1}`,
          );
          expect(await grant?.refresh?.(step - 1)).toEqual(next);
          await grant?.refresh?.(step);
          expect(grant?.binding.token).toBe(rotated);
          const calls = mocks.refresh.mock.calls.length;
          expect(await grant?.refresh?.(step)).toBeUndefined();
          expect(mocks.refresh).toHaveBeenCalledTimes(calls);
        }
      } finally {
        await grant?.revoke();
      }
      expect(grant?.signal?.aborted).toBe(true);
      // Retiring execution must leave the account's canonical profile usable.
      expect((await prepareWorkerGitHubBinding(session))?.token).toBe("synthetic-selected-token-7");
    },
  );

  it("delivers profile rotations automatically, retries failed delivery, and joins delivery on cleanup", async () => {
    const profileDir = await installProfile();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const grant = await prepareWorkerGitHubBindingGrant(session);
    expect(grant).toBeDefined();
    const firstDelivery = createDeferredCore();
    const retryDelivery = createDeferredCore();
    const heldDelivery = createDeferredCore();
    const releaseDelivery = createDeferredCore();
    const followupDelivery = createDeferredCore();
    const releaseFollowup = createDeferredCore();
    const install = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstDelivery.resolve();
        throw new Error("synthetic transient transport failure");
      })
      .mockImplementationOnce(async () => {
        retryDelivery.resolve();
      })
      .mockImplementationOnce(async () => {
        heldDelivery.resolve();
        await releaseDelivery.promise;
      })
      .mockImplementationOnce(async () => {
        followupDelivery.resolve();
        await releaseFollowup.promise;
      });
    const stop = grant!.startRenewal!(install);
    try {
      await writeManagedGitHubProfileFiles(profileDir, {
        login: verified.account.login,
        token: "synthetic-auto-token-1",
      });
      await vi.advanceTimersByTimeAsync(1);
      await firstDelivery.promise;
      expect(grant!.binding.token).toBe(token);
      await vi.advanceTimersByTimeAsync(60_000);
      await retryDelivery.promise;
      // The consumer's completed installation acknowledges the exact pending generation.
      await vi.advanceTimersByTimeAsync(0);
      expect(install).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ generation: 1, token: "synthetic-auto-token-1" }),
      );
      expect(grant!.binding.token).toBe("synthetic-auto-token-1");
      await writeManagedGitHubProfileFiles(profileDir, {
        login: verified.account.login,
        token: "synthetic-auto-token-2",
      });
      await vi.advanceTimersByTimeAsync(1);
      await heldDelivery.promise;
      await writeManagedGitHubProfileFiles(profileDir, {
        login: verified.account.login,
        token: "synthetic-auto-token-3",
      });
      releaseDelivery.resolve();
      await followupDelivery.promise;
      expect(install).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ generation: 3, token: "synthetic-auto-token-3" }),
      );
      let settled = false;
      const cleanup = grant!.revoke().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(grant!.signal!.aborted).toBe(true);
      releaseFollowup.resolve();
      await cleanup;
      expect(settled).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(install).toHaveBeenCalledTimes(4);
    } finally {
      releaseDelivery.resolve();
      releaseFollowup.resolve();
      stop();
      await grant!.revoke();
    }
    expect((await prepareWorkerGitHubBinding(session))?.token).toBe("synthetic-auto-token-3");
  });

  it("keeps a profile rotation that arrives while credential verification is pending", async () => {
    const profileDir = await installProfile();
    vi.useFakeTimers({ toFake: ["Date"] });
    const grant = await prepareWorkerGitHubBindingGrant(session);
    const verifying = createDeferredCore();
    const verifiedRead = createDeferredCore();
    mocks.verify.mockImplementationOnce(async () => {
      verifying.resolve();
      await verifiedRead.promise;
      return verified;
    });
    try {
      vi.setSystemTime(Date.now() + 60_001);
      const refresh = grant!.refresh!();
      await verifying.promise;
      await writeManagedGitHubProfileFiles(profileDir, {
        login: verified.account.login,
        token: "synthetic-concurrent-rotation",
      });
      verifiedRead.resolve();
      await expect(refresh).resolves.toMatchObject({
        generation: 1,
        token: "synthetic-concurrent-rotation",
      });
    } finally {
      verifiedRead.resolve();
      await grant?.revoke();
    }
  });

  it("leaves non-repository turns unbound without accepting a stale session", async () => {
    mocks.session.mockReturnValue({
      canonicalKey: session.sessionKey,
      agentId: "main",
      entry: { sessionId: session.sessionId },
    });
    await expect(prepareWorkerGitHubBindingGrant(session)).resolves.toBeUndefined();
    expect(mocks.verify).not.toHaveBeenCalled();
    mocks.session.mockReturnValue({
      canonicalKey: session.sessionKey,
      agentId: "main",
      entry: { sessionId: "replacement-session" },
    });
    await expect(prepareWorkerGitHubBindingGrant(session)).rejects.toThrow();
  });

  it("refuses missing configured credentials without borrowing the host login", async () => {
    await expect(prepareWorkerGitHubBindingGrant(session)).rejects.toThrow(
      "selected GitHub identity is unavailable",
    );
    expect(mocks.nativeToken).not.toHaveBeenCalled();
  });

  it.each(["selection", "account", "turn"] as const)(
    "closes the execution credential after its %s authority changes",
    async (changed) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await installProfile();
      let current = true;
      const grant = await prepareWorkerGitHubBindingGrant({
        ...session,
        assertCurrent: () => current,
      });
      try {
        if (changed === "selection") {
          config = { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } };
        } else if (changed === "account") {
          mocks.verify.mockResolvedValue({
            ...verified,
            account: { ...verified.account, accountId: 99, login: "another-account" },
          });
        } else {
          current = false;
        }
        vi.setSystemTime(Date.now() + 60_001);
        await expect(grant?.refresh?.()).rejects.toThrow(
          /identity changed|account changed|authority closed/i,
        );
        expect(grant?.signal?.aborted).toBe(true);
      } finally {
        await grant?.revoke();
      }
    },
  );

  it("keeps an existing public managed identity on its host when App host settings change", async () => {
    vi.stubEnv("GITHUB_HOST", "fixture.ghe.com");
    vi.stubEnv("GITHUB_API_BASE_URL", "https://api.fixture.ghe.com");
    await installProfile();
    mocks.repository.mockResolvedValue({
      originUrl: "fixture@fixture.ghe.com:example/repo.git",
    });

    await expect(prepareWorkerGitHubBinding(session)).resolves.toEqual({
      token,
      login: "shared-bot",
      branch: worktree.branch,
      gitAuthor: { name: "Shared Bot" },
    });
    expect(mocks.verify).toHaveBeenCalledWith(token, {
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("uses the agent override author without inheriting system author fields", async () => {
    config.agents = {
      entries: {
        main: { tools: { github: { profileId, gitAuthor: { email: "agent@example.test" } } } },
      },
    };
    await installProfile("agent");
    expect((await prepareWorkerGitHubBinding(session))?.gitAuthor).toEqual({
      email: "agent@example.test",
    });
  });

  it.each([{ name: "Shared\nBot" }, { email: "a".repeat(257) }])(
    "omits launch-invalid author metadata instead of failing the worker turn: %j",
    async (gitAuthor) => {
      config = { tools: { github: { profileId, gitAuthor } } };
      await installProfile();
      await expect(prepareWorkerGitHubBinding(session)).resolves.toBeUndefined();
    },
  );

  it("binds native shared auth without a managed author or non-GitHub remote", async () => {
    config = {};
    mocks.repository.mockResolvedValue({ originUrl: "https://example.test/owner/repo.git" });
    await expect(prepareWorkerGitHubBinding(session)).resolves.toEqual({
      token,
      login: "shared-bot",
      branch: worktree.branch,
    });
  });

  it.each(["missing-profile", "unavailable"] as const)(
    "omits credentials when the managed identity is %s",
    async (failure) => {
      if (failure !== "missing-profile") {
        await installProfile();
        mocks.verify.mockResolvedValue({ status: failure });
      }
      await expect(prepareWorkerGitHubBinding(session)).resolves.toBeUndefined();
      expect(mocks.nativeToken).not.toHaveBeenCalled();
    },
  );

  it.each(["before-preparation", "verification", "repository"])(
    "omits the binding after claim closure during %s",
    async (phase) => {
      await installProfile();
      let current = phase !== "before-preparation";
      mocks.verify.mockImplementation(async () => {
        if (phase === "verification") {
          current = false;
        }
        return verified;
      });
      mocks.repository.mockImplementation(async () => {
        current = false;
        return { originUrl: "git@github.com:owner/repo.git" };
      });
      await expect(
        prepareWorkerGitHubBinding({ ...session, assertCurrent: () => current }),
      ).resolves.toBeUndefined();
      if (phase === "before-preparation") {
        expect(mocks.verify).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["identity", "worktree"])(
    "rejects a %s replacement during repository lookup",
    async (replaced) => {
      await installProfile();
      mocks.repository.mockImplementation(async () => {
        if (replaced === "identity") {
          config = { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } };
        } else {
          mocks.worktree.mockReturnValue({ ...worktree, repoFingerprint: "replacement" });
        }
        return { originUrl: "git@github.com:owner/repo.git" };
      });
      await expect(prepareWorkerGitHubBinding(session)).resolves.toBeUndefined();
    },
  );

  it("uses a refreshed profile on the next turn", async () => {
    const profileDir = await installProfile();
    const first = await prepareWorkerGitHubBinding(session);
    await fs.rm(profileDir, { recursive: true });
    const rotated = "synthetic-worker-github-rotated-token";
    await installManagedGitHubProfile({ profileDir, token: rotated, commitConfig: async () => {} });
    expect(first?.token).toBe(token);
    expect((await prepareWorkerGitHubBinding(session))?.token).toBe(rotated);
  });

  it.each(["current", "replaced", "revoked"] as const)(
    "binds a repository-only session before first checkout while authority is %s",
    async (state) => {
      await installProfile();
      const repository = {
        workspaceId: "repository-workspace",
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        url: "https://github.com/owner/repo.git",
        branch: "openclaw/repository-session",
        baseCommit: null,
        checkpointRef: null,
      };
      mocks.session.mockReturnValue({
        canonicalKey: session.sessionKey,
        agentId: session.agentId,
        entry: { sessionId: session.sessionId, repositoryWorkspaceId: repository.workspaceId },
      });
      mocks.repositoryWorkspace.mockReturnValue(repository);
      let current = true;
      mocks.verify.mockImplementation(async () => {
        if (state === "revoked") {
          current = false;
        }
        if (state === "replaced") {
          mocks.repositoryWorkspace.mockReturnValue({
            ...repository,
            url: "https://github.com/other/repo.git",
          });
        }
        return verified;
      });
      const binding = await prepareWorkerGitHubBinding({
        ...session,
        assertCurrent: () => current,
      });
      if (state === "current") {
        expect(binding).toMatchObject({
          token,
          branch: repository.branch,
          remoteUrl: repository.url,
        });
      } else {
        expect(binding).toBeUndefined();
      }
      expect(mocks.repository).not.toHaveBeenCalled();
      expect(mocks.worktree).not.toHaveBeenCalled();
    },
  );
});
