import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  installManagedGitHubProfile,
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  profileIdentity: vi.fn(),
  profileDisplay: vi.fn(),
}));

vi.mock("../../state/user-profile-list.js", () => ({
  prepareUserProfileIdentity: mocks.profileIdentity,
  getUserProfileDisplay: mocks.profileDisplay,
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
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: mocks.nativeToken }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const profileId = "ghp_11111111111111111111111111111111";
const token = "synthetic-worker-github-binding-token";
const appPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
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
    mocks.profileIdentity.mockReset().mockResolvedValue({
      emailBindingIds: ["verified-email-binding"],
      readCurrentFacts: () => ({ profile: { emails: ["person@example.test"] } }),
      release: vi.fn(),
    });
    mocks.profileDisplay.mockReset().mockReturnValue({ displayName: "Signed-in Person" });
  });
  afterEach(() => {
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

  it("issues one process-scoped enterprise App token and revokes it", async () => {
    vi.stubEnv("GITHUB_HOST", "fixture.ghe.com");
    vi.stubEnv("GITHUB_API_BASE_URL", "https://api.fixture.ghe.com");
    vi.stubEnv("GITHUB_APP_ID", "13361");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "119386");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", appPrivateKey);
    mocks.repository.mockResolvedValue({
      originUrl: "fixture@fixture.ghe.com:example/repo.git",
    });
    const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) =>
      init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(
            JSON.stringify({
              token: "synthetic-installation-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
    );
    vi.stubGlobal("fetch", fetch);

    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "signed-in-person",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    const grant = await prepareWorkerGitHubBindingGrant({ ...session, operatorAuthority });

    expect(grant?.binding).toEqual({
      token: "synthetic-installation-token",
      login: "x-access-token",
      branch: worktree.branch,
      host: "fixture.ghe.com",
      remoteUrl: "https://fixture.ghe.com/example/repo.git",
      gitAuthor: { name: "Signed-in Person", email: "person@example.test" },
    });
    await grant?.revoke();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });

    const codexGrant = await prepareWorkerGitHubBindingGrant(session);
    expect(codexGrant?.binding).toEqual({
      token: "synthetic-installation-token",
      login: "x-access-token",
      branch: worktree.branch,
      host: "fixture.ghe.com",
      remoteUrl: "https://fixture.ghe.com/example/repo.git",
    });
    await codexGrant?.revoke();
    await expect(
      prepareWorkerGitHubBindingGrant({ ...session, requireOperatorAuthority: true }),
    ).rejects.toThrow("signed-in operator authority");
    expect(fetch.mock.calls.at(-1)?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("retains selected identity on a non-GitHub workspace without App settings", async () => {
    config = {};
    mocks.repository.mockResolvedValue({ originUrl: "https://example.test/owner/repo.git" });
    await expect(prepareWorkerGitHubBindingGrant(session)).resolves.toMatchObject({
      binding: { token, login: "shared-bot", branch: worktree.branch },
    });
  });

  it("keeps the selected identity when App settings are only partially present", async () => {
    vi.stubEnv("GITHUB_APP_ID", "13361");
    await installProfile();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(prepareWorkerGitHubBindingGrant(session)).resolves.toMatchObject({
      binding: { token, login: "shared-bot" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps an explicit agent override ahead of the App installation", async () => {
    vi.stubEnv("GITHUB_APP_ID", "13361");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "119386");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", appPrivateKey);
    config.agents = { entries: { main: { tools: { github: { profileId } } } } };
    await installProfile("agent");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(prepareWorkerGitHubBindingGrant(session)).resolves.toMatchObject({
      binding: { token, login: "shared-bot" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revokes a minted App token if workspace revalidation throws", async () => {
    vi.stubEnv("GITHUB_APP_ID", "13361");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "119386");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", appPrivateKey);
    const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) =>
      init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(
            JSON.stringify({
              token: "synthetic-installation-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
    );
    vi.stubGlobal("fetch", fetch);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "signed-in-person",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    mocks.worktree
      .mockImplementationOnce(() => worktree)
      .mockImplementation(() => {
        throw new Error("workspace changed");
      });
    await expect(
      prepareWorkerGitHubBindingGrant({ ...session, operatorAuthority }),
    ).rejects.toThrow("workspace changed");
    expect(fetch.mock.calls.at(-1)?.[1]).toMatchObject({ method: "DELETE" });
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
