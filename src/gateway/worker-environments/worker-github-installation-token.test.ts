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
    GITHUB_HOST: "fixture.ghe.com",
    GITHUB_API_BASE_URL: "https://api.fixture.ghe.com",
    GITHUB_APP_ID: "13361",
    GITHUB_INSTALLATION_ID: "119386",
    GITHUB_APP_PRIVATE_KEY: pem,
  };
}

describe("worker GitHub App installation-token issuer", () => {
  it("uses the public GitHub API when no enterprise endpoint is configured", async () => {
    const publicEnv = env();
    delete publicEnv.GITHUB_HOST;
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
      host: "github.com",
      env: publicEnv,
      fetch,
    });
    await grant?.revoke();
    expect(calls).toEqual([
      "https://api.github.com/app/installations/119386/access_tokens",
      "https://api.github.com/installation/token",
    ]);
  });

  it.each(["caller", "deadline"] as const)(
    "settles issuance when the %s signal closes",
    async (source) => {
      const caller = new AbortController();
      const deadline = new AbortController();
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => (ms === 10_000 ? deadline.signal : nativeTimeout(ms)));
      let issuedSignal: AbortSignal | null | undefined;
      let rejected: Promise<void> | undefined;
      let started: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
        issuedSignal = init.signal;
        started();
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("issuance cancelled")), {
            once: true,
          });
        });
      }) as typeof globalThis.fetch;
      try {
        const pending = issueWorkerGitHubInstallationToken({
          host: "fixture.ghe.com",
          env: env(),
          fetch,
          signal: caller.signal,
        });
        rejected = expect(pending).rejects.toThrow("issuance cancelled");
        await ready;
        (source === "caller" ? caller : deadline).abort();
        expect(issuedSignal?.aborted).toBe(true);
        await rejected;
      } finally {
        caller.abort();
        await rejected;
        timeout.mockRestore();
      }
    },
  );

  it("uses the installation's configured scope and revokes the grant once", async () => {
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
      GITHUB_HOST: "github.example.test",
      GITHUB_API_BASE_URL: "https://github.example.test/api/v3",
    };
    const grant = await issueWorkerGitHubInstallationToken({
      host: "github.example.test",
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
    expect(calls[0]?.init.body).toBe("{}");
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
      issueWorkerGitHubInstallationToken({
        host: "fixture.ghe.com",
        env: partial,
        fetch,
      }),
    ).rejects.toThrow("configuration is incomplete");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a different API tenant before issuing a worker credential", async () => {
    const fetch = vi.fn();
    await expect(
      issueWorkerGitHubInstallationToken({
        host: "fixture.ghe.com",
        env: { ...env(), GITHUB_API_BASE_URL: "https://api.other.ghe.com" },
        fetch,
      }),
    ).rejects.toThrow("must match GITHUB_HOST");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a repository owned by another installation before token issuance", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request) => Response.json({ id: 119387 }));
    await expect(
      issueWorkerGitHubInstallationToken({
        host: "fixture.ghe.com",
        repository: { owner: "example", repo: "project" },
        env: env(),
        fetch: fetch as typeof globalThis.fetch,
      }),
    ).rejects.toThrow("does not include the workspace repository");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetch.mock.calls[0]![0])).toBe(
      "https://api.fixture.ghe.com/repos/example/project/installation",
    );
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
      issueWorkerGitHubInstallationToken({
        host: "fixture.ghe.com",
        env: env(),
        fetch,
      }),
    ).rejects.toThrow("invalid installation token");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.for(["response", "network"] as const)(
    "retains revocation ownership after a $0 failure so cleanup can retry",
    async (failure) => {
      let deletes = 0;
      const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
        if (init.method === "DELETE") {
          deletes += 1;
          if (deletes === 1 && failure === "network") {
            throw new Error("synthetic network unavailable");
          }
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
        host: "fixture.ghe.com",
        env: env(),
        fetch,
      });

      await expect(grant?.revoke()).rejects.toThrow(
        failure === "network" ? "synthetic network unavailable" : "revocation failed",
      );
      await expect(grant?.revoke()).resolves.toBeUndefined();
      expect(deletes).toBe(2);
    },
  );
});
