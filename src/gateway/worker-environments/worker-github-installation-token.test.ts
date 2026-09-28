import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issueWorkerGitHubInstallationToken } from "./worker-github-installation-token.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function env(): NodeJS.ProcessEnv {
  return {
    GITHUB_API_BASE_URL: "https://api.fixture.ghe.com",
    GITHUB_APP_ID: "13361",
    GITHUB_INSTALLATION_ID: "119386",
    GITHUB_APP_PRIVATE_KEY: pem,
  };
}

describe("worker GitHub App installation-token issuer", () => {
  it("uses the public GitHub API when no enterprise endpoint is configured", async () => {
    const publicEnv = env();
    delete publicEnv.GITHUB_API_BASE_URL;
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push(requestUrl(input));
      return init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({
            token: "synthetic-public-installation-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
    }) as typeof globalThis.fetch;

    const grant = await issueWorkerGitHubInstallationToken({
      repository: "project",
      env: publicEnv,
      fetch,
    });
    await grant?.revoke();
    expect(calls).toEqual([
      "https://api.github.com/app/installations/119386/access_tokens",
      "https://api.github.com/installation/token",
    ]);
  });

  it("limits the grant to the workspace repository and revokes it once", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: requestUrl(input), init });
      if (init.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({
          token: "synthetic-full-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const serverEnv = {
      ...env(),
      GITHUB_API_BASE_URL: "https://github.example.test/api/v3",
    };
    const grant = await issueWorkerGitHubInstallationToken({
      repository: "project",
      env: serverEnv,
      fetch,
    });

    expect(grant?.token).toBe("synthetic-full-installation-token");
    expect(calls[0]?.url).toBe(
      "https://github.example.test/api/v3/app/installations/119386/access_tokens",
    );
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: expect.stringMatching(/^Bearer [^.]+\.[^.]+\.[^.]+$/u),
    });
    expect(calls[0]?.init.body).toBe('{"repositories":["project"]}');
    await grant?.revoke();
    await grant?.revoke();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      url: "https://github.example.test/api/v3/installation/token",
      init: { method: "DELETE" },
    });
    expect(calls[1]?.init.headers).toMatchObject({
      authorization: "Bearer synthetic-full-installation-token",
    });
  });

  it("fails closed on partial issuer configuration before network access", async () => {
    const fetch = vi.fn();
    const partial = env();
    delete partial.GITHUB_INSTALLATION_ID;
    await expect(
      issueWorkerGitHubInstallationToken({ repository: "project", env: partial, fetch }),
    ).rejects.toThrow("configuration is incomplete");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revokes a malformed issued token before rejecting it", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) =>
      init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(
            JSON.stringify({
              token: "synthetic-invalid-token",
              expires_at: "not-a-time",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
    ) as typeof globalThis.fetch;
    await expect(
      issueWorkerGitHubInstallationToken({ repository: "project", env: env(), fetch }),
    ).rejects.toThrow("invalid installation token");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains revocation ownership after a failed delete so cleanup can retry", async () => {
    let deletes = 0;
    const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
      if (init.method === "DELETE") {
        deletes += 1;
        return new Response(null, { status: deletes === 1 ? 503 : 204 });
      }
      return new Response(
        JSON.stringify({
          token: "synthetic-retry-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    const grant = await issueWorkerGitHubInstallationToken({
      repository: "project",
      env: env(),
      fetch,
    });

    await expect(grant?.revoke()).rejects.toThrow("revocation failed");
    await expect(grant?.revoke()).resolves.toBeUndefined();
    expect(deletes).toBe(2);
  });
});
