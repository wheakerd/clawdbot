import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { captureGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { DecisionProviderV1 } from "./provider-types.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

describe("decision consumer consent", () => {
  it.each(["before-invocation", "readiness"] as const)(
    "checks admission at %s without poisoning provider health",
    async (stage) => {
      let allowed = stage === "readiness";
      const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
      const host = registered(evaluate, () => {
        allowed = false;
        return true;
      });
      expect(await host.run({ ...options(), admit: () => allowed })).toEqual({
        status: "unavailable",
        reason: "disabled",
      });
      expect(evaluate).not.toHaveBeenCalled();
      expect(host.registry.decisionProviders[0]?.host.inspect(config).callable).toBe(true);
    },
  );

  it.each(["allowed", "denied", "invalid"] as const)(
    "checks %s admission after awaited network preparation and cleanup",
    async (kind) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      onTestFinished(() => clock.mockRestore());
      let allowed = true;
      const preparing = createDeferredCore();
      const release = createDeferredCore();
      const fetch = vi.fn(async () => new Response("ok"));
      let retained: (() => void) | undefined;
      const host = registered(async () => {
        retained = captureGuardedFetchRequestAuthority();
        try {
          const result = await fetchWithSsrFGuard({
            url: "https://decision.example/evaluate",
            fetchImpl: fetch,
            lookupFn: async () => {
              preparing.resolve();
              await release.promise;
              return [{ address: "93.184.216.34", family: 4 }];
            },
            init: { method: "POST", body: JSON.stringify(batch) },
          });
          await result.response.body?.cancel();
          await result.release();
          return answer;
        } catch {
          // A translated transport error and late cleanup cannot revive admission.
          allowed = true;
          clock.mockReturnValue(1_001);
          return { status: "unavailable", reason: "transport" };
        }
      });
      const pending = host.run({
        ...options(),
        admit: () => {
          if (!allowed && kind === "invalid") {
            throw new Error("private callback diagnostics");
          }
          return allowed;
        },
      });
      await preparing.promise;
      allowed = kind === "allowed";
      release.resolve();
      if (kind === "invalid") {
        await expect(pending).rejects.toThrow("Invalid decision contract");
      } else {
        expect(await pending).toMatchObject(
          kind === "allowed" ? { status: "ok" } : { status: "unavailable", reason: "disabled" },
        );
      }
      expect(fetch).toHaveBeenCalledTimes(kind === "allowed" ? 1 : 0);
      expect(retained).toBeTypeOf("function");
      expect(() => retained?.()).toThrow("no longer active");
      const health = host.registry.decisionProviders[0]?.host.inspect(config);
      expect(health?.callable).toBe(true);
      expect(health?.reasons.deadline).toBeUndefined();
    },
  );

  it("discards a successful answer after consent withdrawal", async () => {
    let allowed = true;
    const release = createDeferredCore();
    const host = registered(async () => {
      await release.promise;
      return answer;
    });
    const pending = host.run({ ...options(), admit: () => allowed });
    await host.started;
    allowed = false;
    release.resolve();
    expect(await pending).toEqual({ status: "unavailable", reason: "disabled" });
    expect(host.registry.decisionProviders[0]?.host.inspect(config).successCount).toBe(0);
  });

  it.each([
    () => undefined,
    () => Promise.reject(new Error("private callback detail")),
    () => {
      throw new Error("private callback detail");
    },
  ])("fails closed on invalid admission callbacks", async (admit) => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    const host = registered(evaluate);
    const request = options();
    // Exercise invalid JavaScript callers at the typed API boundary.
    Reflect.set(request, "admit", admit);
    await expect(host.run(request)).rejects.toThrow("Invalid decision contract");
    expect(evaluate).not.toHaveBeenCalled();
  });
});
