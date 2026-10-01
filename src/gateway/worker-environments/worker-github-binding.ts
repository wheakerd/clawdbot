import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import {
  GITHUB_PUBLIC_HOST,
  resolveGitHubHost,
  resolveGitHubAppApiBaseUrl,
} from "../../agents/github-host.js";
import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  onUserProfileEmailBindingChanged,
  onUserProfilesChanged,
} from "../../state/user-profile-events.js";
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
import type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";
import {
  issueWorkerGitHubInstallationToken,
  WorkerGitHubRepositoryUnavailableError,
  workerGitHubAppConfigurationState,
} from "./worker-github-installation-token.js";

type WorkerGitHubBinding = WorkerGitHubLaunchBinding;

const log = createSubsystemLogger("gateway/worker-github");

export type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";

/** Credential cleanup cannot erase work already accepted by its execution owner. */
export async function revokeWorkerGitHubBindingGrant(
  grant: WorkerGitHubBindingGrant | undefined,
): Promise<void> {
  try {
    await grant?.revoke();
  } catch {
    log.warn(
      "Worker GitHub cleanup failed; accepted work still reconciles and final cleanup can retry.",
    );
  }
}

export async function prepareWorkerGitHubBindingGrant(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  requireOperatorAuthority?: boolean;
  appOnly?: boolean;
  signal?: AbortSignal;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  if (params.signal?.aborted || params.assertCurrent?.() === false) {
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
  let readWorkspace: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>;
  let workspace: ReturnType<typeof readWorkspace>;
  let originUrl: string;
  try {
    readWorkspace = await prepareGitHubPublicationWorkspaceOwner(params);
    workspace = readWorkspace();
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
  const sourceAbort = new AbortController();
  const signal = AbortSignal.any(
    [params.signal, operator?.signal, sourceAbort.signal].filter(
      (source): source is AbortSignal => source !== undefined,
    ),
  );
  signal.throwIfAborted();
  let appGrant: Awaited<ReturnType<typeof issueWorkerGitHubInstallationToken>>;
  try {
    appGrant = await issueWorkerGitHubInstallationToken({
      host: githubHost,
      repository: remote,
      signal,
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
  let currentAppGrant = appGrant;
  const retiredGrants = new Set<typeof currentAppGrant>();
  const revokeAppGrant = async (candidate = currentAppGrant) => {
    retiredGrants.add(candidate);
    try {
      await candidate.revoke();
      retiredGrants.delete(candidate);
    } catch {
      log.warn("Worker GitHub token revocation failed; the installation token will expire.");
    }
  };
  let retainedProfile = false;
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
    const currentWorkspace = readWorkspace();
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
    if (
      resolveConfiguredGitHubToolIdentity({
        config: currentGitHubPublicationConfig(),
        agentId: params.agentId,
        scope: "agent",
      })
    ) {
      await revokeAppGrant();
      return selectedIdentityGrant();
    }
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
    signal.throwIfAborted();
    const subscriptions: (() => void)[] = [];
    let revoked = false;
    let revocation: Promise<void> | undefined;
    let refreshing: Promise<WorkerGitHubBindingRefresh | undefined> | undefined;
    let generation = 0;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let deliveryWork: Promise<void> | undefined;
    let renewalStarted = false;
    let renewalStopped = false;
    let currentBinding = binding;
    let pending: { grant: typeof currentAppGrant; refresh: WorkerGitHubBindingRefresh } | undefined;
    const issuerAppId = process.env.GITHUB_APP_ID;
    const issuerInstallationId = process.env.GITHUB_INSTALLATION_ID;
    const issuerApiBase = resolveGitHubAppApiBaseUrl(githubHost);
    const assertGrantCurrent = () => {
      try {
        signal.throwIfAborted();
        operator?.assertCurrent();
        profile?.readCurrentFacts(bindingIds);
        if (
          revoked ||
          params.assertCurrent?.() === false ||
          process.env.GITHUB_APP_ID !== issuerAppId ||
          process.env.GITHUB_INSTALLATION_ID !== issuerInstallationId ||
          resolveGitHubHost() !== githubHost ||
          resolveGitHubAppApiBaseUrl(githubHost) !== issuerApiBase ||
          resolveConfiguredGitHubToolIdentity({
            config: currentGitHubPublicationConfig(),
            agentId: params.agentId,
            scope: "agent",
          }) ||
          !sameGitHubPublicationWorkspace(workspace, readWorkspace())
        ) {
          throw new Error("Worker GitHub credential authority closed");
        }
      } catch (error) {
        sourceAbort.abort(error);
        throw error;
      }
    };
    const revoke = (): Promise<void> => {
      if (!revocation) {
        revoked = true;
        clearTimeout(renewalTimer);
        signal.removeEventListener("abort", onAbort);
        subscriptions.splice(0).forEach((stop) => stop());
        sourceAbort.abort(new Error("Worker GitHub credential authority closed"));
        revocation = Promise.resolve()
          .then(async () => {
            await refreshing?.catch(() => undefined);
            await deliveryWork?.catch(() => undefined);
            if (pending) {
              retiredGrants.add(pending.grant);
              pending = undefined;
            }
            retiredGrants.add(currentAppGrant);
            await Promise.all([...retiredGrants].map(revokeAppGrant));
          })
          .finally(() => {
            profile?.release();
            profile = undefined;
            revocation = undefined;
          });
      }
      return revocation;
    };
    const onAbort = () => {
      void revoke();
    };
    const refresh = (
      installedGeneration?: number,
    ): Promise<WorkerGitHubBindingRefresh | undefined> => {
      if (!refreshing) {
        refreshing = (async () => {
          assertGrantCurrent();
          if (pending && pending.refresh.expiresAtMs <= Date.now()) {
            await revokeAppGrant(pending.grant);
            pending = undefined;
            assertGrantCurrent();
          }
          if (pending && installedGeneration === pending.refresh.generation) {
            const previous = currentAppGrant;
            currentAppGrant = pending.grant;
            currentBinding = { ...currentBinding, token: pending.refresh.token };
            pending = undefined;
            await revokeAppGrant(previous);
            assertGrantCurrent();
          }
          if (pending) {
            return pending.refresh;
          }
          if (currentAppGrant.expiresAtMs - Date.now() > 300_000) {
            return undefined;
          }
          const next = await issueWorkerGitHubInstallationToken({
            host: githubHost,
            repository: remote,
            signal,
          });
          if (!next) {
            throw new Error("Worker GitHub App issuer unavailable during renewal");
          }
          try {
            const refreshedOrigin =
              workspace.kind === "repository"
                ? originUrl
                : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path))
                    .originUrl;
            const refreshedRemote = parseGitHubRemoteUrl(refreshedOrigin, githubHost);
            assertGrantCurrent();
            if (
              refreshedRemote?.owner.toLowerCase() !== remote.owner.toLowerCase() ||
              refreshedRemote?.repo.toLowerCase() !== remote.repo.toLowerCase()
            ) {
              sourceAbort.abort(new Error("Worker GitHub workspace changed during renewal"));
              throw new Error("Worker GitHub workspace changed during renewal");
            }
            pending = {
              grant: next,
              refresh: {
                generation: ++generation,
                token: next.token,
                expiresAtMs: next.expiresAtMs,
              },
            };
            return pending.refresh;
          } catch (error) {
            await revokeAppGrant(next);
            throw error;
          }
        })()
          .catch(() => {
            assertGrantCurrent();
            log.warn(
              "Worker GitHub renewal failed; retaining the current profile for the next heartbeat.",
            );
            return undefined;
          })
          .finally(() => {
            refreshing = undefined;
          });
      }
      return refreshing;
    };
    const startRenewal = (install: (snapshot: WorkerGitHubBindingRefresh) => Promise<void>) => {
      assertGrantCurrent();
      if (renewalStarted) {
        throw new Error("Worker GitHub grant already has a renewal consumer");
      }
      renewalStarted = true;
      const schedule = (delayMs: number) => {
        renewalTimer = setTimeout(() => {
          deliveryWork = (async () => {
            const snapshot = await refresh();
            if (snapshot) {
              assertGrantCurrent();
              await install(snapshot);
              assertGrantCurrent();
              await refresh(snapshot.generation);
            }
          })()
            .catch(() => {
              if (!revoked && !signal.aborted) {
                log.warn(
                  "Worker GitHub profile renewal failed; retrying while the grant remains current.",
                );
              }
            })
            .finally(() => {
              deliveryWork = undefined;
              if (!revoked && !renewalStopped && !signal.aborted) {
                schedule(Math.max(60_000, currentAppGrant.expiresAtMs - Date.now() - 300_000));
              }
            });
        }, delayMs);
        renewalTimer.unref?.();
      };
      schedule(Math.max(1, currentAppGrant.expiresAtMs - Date.now() - 300_000));
      return () => {
        renewalStopped = true;
        clearTimeout(renewalTimer);
      };
    };
    const recheck = () => {
      if (!revoked) {
        try {
          assertGrantCurrent();
        } catch {
          /* The closed signal owns revocation. */
        }
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    subscriptions.push(onUserProfilesChanged(recheck), onUserProfileEmailBindingChanged(recheck));
    retainedProfile = true;
    return {
      get binding() {
        return currentBinding;
      },
      get expiresAtMs() {
        return currentAppGrant.expiresAtMs;
      },
      signal,
      assertCurrent: assertGrantCurrent,
      refresh,
      startRenewal,
      revoke,
    };
  } catch (error) {
    await revokeAppGrant();
    throw error;
  } finally {
    if (!retainedProfile) {
      profile?.release();
    }
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
