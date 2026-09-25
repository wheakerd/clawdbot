import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isOnlySecretStoreReference } from "./located-secret-refs.js";

const ref = { source: "store", provider: "default", id: "SERVICE_API_KEY" } as const;
const path = ["skills", "entries", "service", "apiKey"];
const exclusive = { skills: { entries: { service: { apiKey: ref } } } } as OpenClawConfig;

describe("isOnlySecretStoreReference", () => {
  it("allows in-place rotation for the single referencing config key", () => {
    expect(
      isOnlySecretStoreReference({ sourceConfig: exclusive, authStores: [], path, name: ref.id }),
    ).toBe(true);
  });

  it.each([
    {
      case: "without a runtime snapshot",
      sourceConfig: exclusive,
      authStores: undefined,
    },
    {
      case: "when another config key uses the entry",
      sourceConfig: {
        skills: { entries: { service: { apiKey: ref }, other: { apiKey: ref } } },
      } as OpenClawConfig,
      authStores: [],
    },
    {
      case: "when an auth profile uses the entry",
      sourceConfig: exclusive,
      authStores: [{ store: { profiles: { "openai:work": { type: "api_key", keyRef: ref } } } }],
    },
  ])("refuses in-place rotation $case", ({ sourceConfig, authStores }) => {
    expect(isOnlySecretStoreReference({ sourceConfig, authStores, path, name: ref.id })).toBe(
      false,
    );
  });
});
