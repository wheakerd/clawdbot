import { createPrivateKey, createSign } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGitHubAppApiBaseUrl } from "../../agents/github-host.js";

type AppConfig = {
  appId: number;
  installationId: number;
  privateKey: ReturnType<typeof createPrivateKey>;
};

const APP_ENV_NAMES = [
  "GITHUB_APP_ID",
  "GITHUB_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

export function workerGitHubAppConfigurationState(
  env: NodeJS.ProcessEnv = process.env,
): "absent" | "partial" | "complete" {
  const configured = APP_ENV_NAMES.filter((name) => Boolean(env[name])).length;
  return configured === 0 ? "absent" : configured === APP_ENV_NAMES.length ? "complete" : "partial";
}

export function hasWorkerGitHubAppConfiguration(env: NodeJS.ProcessEnv = process.env): boolean {
  return workerGitHubAppConfigurationState(env) === "complete";
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function resolveAppConfig(env: NodeJS.ProcessEnv): AppConfig | undefined {
  const state = workerGitHubAppConfigurationState(env);
  if (state === "absent") {
    return undefined;
  }
  if (state === "partial") {
    throw new Error("Worker GitHub App issuer configuration is incomplete");
  }
  const appId = positiveInteger(env.GITHUB_APP_ID);
  const installationId = positiveInteger(env.GITHUB_INSTALLATION_ID);
  if (!appId || !installationId || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("Worker GitHub App issuer configuration is invalid");
  }
  return {
    appId,
    installationId,
    privateKey: createPrivateKey(env.GITHUB_APP_PRIVATE_KEY),
  };
}

function appJwt(config: AppConfig, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: String(config.appId),
    iat: seconds - 60,
    exp: seconds + 540,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(config.privateKey).toString("base64url")}`;
}

export type WorkerGitHubInstallationTokenGrant = {
  token: string;
  expiresAtMs: number;
  revoke: () => Promise<void>;
};

export class WorkerGitHubRepositoryUnavailableError extends Error {}

export async function issueWorkerGitHubInstallationToken(params: {
  host: string;
  repository?: { owner: string; repo: string };
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<WorkerGitHubInstallationTokenGrant | undefined> {
  const env = params.env ?? process.env;
  const config = resolveAppConfig(env);
  if (!config) {
    return undefined;
  }
  const apiBase = resolveGitHubAppApiBaseUrl(params.host, env);
  const transport = params.fetch ?? fetch;
  const authorization = `Bearer ${appJwt(config)}`;
  if (params.repository) {
    const owner = await transport(
      `${apiBase}/repos/${encodeURIComponent(params.repository.owner)}/${encodeURIComponent(params.repository.repo)}/installation`,
      {
        method: "GET",
        redirect: "error",
        signal: params.signal
          ? AbortSignal.any([params.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        headers: {
          authorization,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (owner.status === 404) {
      void owner.body?.cancel();
      throw new WorkerGitHubRepositoryUnavailableError(
        "GitHub App installation does not include the workspace repository",
      );
    }
    if (!owner.ok) {
      void owner.body?.cancel();
      throw new Error("GitHub App repository ownership verification failed");
    }
    let installation: unknown;
    try {
      installation = await owner.json();
    } catch {
      throw new Error("GitHub App repository ownership verification failed");
    }
    if (!isRecord(installation) || installation.id !== config.installationId) {
      throw new WorkerGitHubRepositoryUnavailableError(
        "GitHub App installation does not include the workspace repository",
      );
    }
  }
  const response = await transport(
    `${apiBase}/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      redirect: "error",
      signal: params.signal
        ? AbortSignal.any([params.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      headers: {
        authorization,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: "{}",
    },
  );
  if (!response.ok) {
    throw new Error("GitHub installation-token issuance failed");
  }
  const issued: unknown = await response.json();
  const record = isRecord(issued) ? issued : {};
  const token = typeof record.token === "string" ? record.token : "";
  const expiresAtMs = typeof record.expires_at === "string" ? Date.parse(record.expires_at) : 0;
  const revokeToken = async () =>
    await transport(`${apiBase}/installation/token`, {
      method: "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
  const invalid = !token || !(expiresAtMs > Date.now());
  if (invalid) {
    if (token) {
      await revokeToken().catch(() => undefined);
    }
    throw new Error("GitHub returned an invalid installation token");
  }
  let active = true;
  return {
    token,
    expiresAtMs,
    revoke: async () => {
      if (!active) {
        return;
      }
      active = false;
      try {
        const revoked = await revokeToken();
        if (!revoked.ok && revoked.status !== 404) {
          throw new Error("GitHub installation-token revocation failed");
        }
      } catch (error) {
        active = true;
        throw error;
      }
    },
  };
}
