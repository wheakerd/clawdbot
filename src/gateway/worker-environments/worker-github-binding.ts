import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { GITHUB_PUBLIC_HOST, resolveGitHubHost } from "../../agents/github-host.js";
import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getUserProfileDisplay,
  prepareUserProfileIdentity,
} from "../../state/user-profile-list.js";
import {
  parseWorkerGitHubLaunchBinding,
  type WorkerGitHubLaunchBinding,
} from "../../worker/launch-descriptor.js";
import {
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationWorkspaceOwner,
  sameGitHubPublicationWorkspace,
} from "../github-publication-availability.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import {
  issueWorkerGitHubInstallationToken,
  WorkerGitHubRepositoryUnavailableError,
  workerGitHubAppConfigurationState,
} from "./worker-github-installation-token.js";

type WorkerGitHubBinding = WorkerGitHubLaunchBinding;

const log = createSubsystemLogger("gateway/worker-github");

export type WorkerGitHubBindingGrant = {
  binding: WorkerGitHubBinding;
  expiresAtMs?: number;
  revoke: () => Promise<void>;
};

export async function prepareWorkerGitHubBindingGrant(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  requireOperatorAuthority?: boolean;
  appOnly?: boolean;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  if (params.assertCurrent?.() === false) {
    return undefined;
  }
  const selectedIdentityGrant = async () => {
    if (params.appOnly) {
      return undefined;
    }
    const binding = await prepareWorkerGitHubBinding(params);
    return binding ? { binding, revoke: async () => {} } : undefined;
  };
  const configuredAgent = resolveConfiguredGitHubToolIdentity({
    config: currentGitHubPublicationConfig(),
    agentId: params.agentId,
    scope: "agent",
  });
  const appState = workerGitHubAppConfigurationState();
  if (appState === "partial") {
    log.warn("Worker GitHub App settings are incomplete; using the selected GitHub identity.");
  }
  if (appState !== "complete" || configuredAgent) {
    return selectedIdentityGrant();
  }
  let workspace: ReturnType<typeof resolveGitHubPublicationWorkspaceOwner>;
  let originUrl: string;
  try {
    workspace = resolveGitHubPublicationWorkspaceOwner(params);
    originUrl =
      workspace.kind === "repository"
        ? workspace.workspace.url
        : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path)).originUrl;
  } catch {
    return selectedIdentityGrant();
  }
  if (params.assertCurrent?.() === false) {
    return undefined;
  }
  const githubHost = resolveGitHubHost();
  const remote = parseGitHubRemoteUrl(originUrl, githubHost);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    return selectedIdentityGrant();
  }
  const caller = getGatewayToolCallerIdentity();
  const operator =
    params.operatorAuthority ??
    (caller?.agentId === params.agentId && caller.sessionKey === params.sessionKey
      ? caller.operatorAuthority
      : undefined);
  if (params.requireOperatorAuthority && !operator) {
    throw new Error("Worker GitHub commits require signed-in operator authority");
  }
  if (operator) {
    assertAdmittedRunOperatorAuthority(operator);
    operator.assertCurrent();
  }
  let appGrant: Awaited<ReturnType<typeof issueWorkerGitHubInstallationToken>>;
  try {
    appGrant = await issueWorkerGitHubInstallationToken({
      host: githubHost,
      repository: remote,
    });
  } catch (error) {
    if (error instanceof WorkerGitHubRepositoryUnavailableError) {
      log.warn("Worker GitHub App does not include this workspace; using selected identity.");
      return selectedIdentityGrant();
    }
    throw error;
  }
  if (!appGrant) {
    throw new Error("Worker GitHub App configuration disappeared during issuance");
  }
  const revokeAppGrant = async () => {
    try {
      await appGrant.revoke();
    } catch {
      log.warn("Worker GitHub token revocation failed; the installation token will expire.");
    }
  };
  let profile: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  try {
    let gitAuthor: { name: string; email: string } | undefined;
    let bindingIds: readonly string[] = [];
    if (operator) {
      assertAdmittedRunOperatorAuthority(operator);
      operator.assertCurrent();
      profile = await prepareUserProfileIdentity(operator.profileId);
      operator.assertCurrent();
      bindingIds = profile.emailBindingIds;
      const email = profile.readCurrentFacts(bindingIds).profile.emails[0];
      if (!email) {
        throw new Error("The signed-in user needs a verified profile email");
      }
      const name = getUserProfileDisplay(operator.profileId).displayName?.trim() || email;
      gitAuthor = { name, email };
    }
    const currentOriginUrl =
      workspace.kind === "repository"
        ? originUrl
        : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path)).originUrl;
    const currentWorkspace = resolveGitHubPublicationWorkspaceOwner(params);
    const currentRemote = parseGitHubRemoteUrl(currentOriginUrl, githubHost);
    if (
      params.assertCurrent?.() === false ||
      !sameGitHubPublicationWorkspace(workspace, currentWorkspace) ||
      currentRemote?.owner.toLowerCase() !== remote.owner.toLowerCase() ||
      currentRemote?.repo.toLowerCase() !== remote.repo.toLowerCase()
    ) {
      await revokeAppGrant();
      return undefined;
    }
    operator?.assertCurrent();
    profile?.readCurrentFacts(bindingIds);
    const binding = parseWorkerGitHubLaunchBinding({
      token: appGrant.token,
      login: "x-access-token",
      ...(githubHost === "github.com" ? {} : { host: githubHost }),
      branch:
        workspace.kind === "repository" ? workspace.workspace.branch : workspace.worktree.branch,
      remoteUrl: `https://${githubHost}/${remote.owner}/${remote.repo}.git`,
      ...(gitAuthor ? { gitAuthor } : {}),
    });
    if (!binding) {
      throw new Error("GitHub App identity does not meet the worker launch contract");
    }
    return { binding, expiresAtMs: appGrant.expiresAtMs, revoke: appGrant.revoke };
  } catch (error) {
    await revokeAppGrant();
    throw error;
  } finally {
    profile?.release();
  }
}

export async function prepareWorkerGitHubBinding(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
}): Promise<WorkerGitHubLaunchBinding | undefined> {
  try {
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    const currentWorkspace = await prepareGitHubPublicationWorkspaceOwner(params);
    const workspace = currentWorkspace();
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId).catch(() => {
      const config = currentGitHubPublicationConfig();
      const managed = (["agent", "system"] as const).some((scope) =>
        resolveConfiguredGitHubToolIdentity({ config, agentId: params.agentId, scope }),
      );
      if (managed && params.assertCurrent?.() !== false) {
        log.warn(
          "Worker GitHub identity unavailable; reconnect the shared GitHub account in Settings.",
        );
      } else {
        log.debug("Worker GitHub identity unavailable.");
      }
      return undefined;
    });
    if (!identity || params.assertCurrent?.() === false) {
      return undefined;
    }
    const originUrl =
      workspace.kind === "repository"
        ? workspace.workspace.url
        : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path)).originUrl;
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    if (
      !sameGitHubPublicationWorkspace(workspace, currentWorkspace()) ||
      !matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })
    ) {
      return undefined;
    }
    const token = identity.env.GH_TOKEN;
    if (!token) {
      return undefined;
    }
    const githubHost = GITHUB_PUBLIC_HOST;
    const remote = parseGitHubRemoteUrl(originUrl, githubHost);
    const remoteUrl =
      remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo)
        ? `https://${githubHost}/${remote.owner}/${remote.repo}.git`
        : undefined;
    const scope =
      identity.source === "agent-override"
        ? "agent"
        : identity.source === "system-configured"
          ? "system"
          : undefined;
    const gitAuthor = scope
      ? resolveConfiguredGitHubToolIdentity({
          config: currentGitHubPublicationConfig(),
          agentId: params.agentId,
          scope,
        })?.gitAuthor
      : undefined;
    const binding = parseWorkerGitHubLaunchBinding({
      token,
      login: identity.account.login,
      ...(githubHost === "github.com" ? {} : { host: githubHost }),
      branch:
        workspace.kind === "repository" ? workspace.workspace.branch : workspace.worktree.branch,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(gitAuthor ? { gitAuthor } : {}),
    });
    if (!binding) {
      log.debug("Worker GitHub binding does not meet the worker launch contract.");
    }
    return binding;
  } catch {
    log.debug("Worker GitHub binding unavailable for the current session workspace.");
    return undefined;
  }
}
