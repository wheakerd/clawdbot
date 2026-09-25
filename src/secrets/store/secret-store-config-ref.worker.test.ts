import { afterEach, beforeEach, expect, it } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  listSecretStoreEntries,
  readSecretStoreValue,
  writeSecretStoreEntry,
  writeSecretStoreEntryForConfigRef,
} from "./secret-store.js";

const team = { kind: "team" } as const;
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "secret-config-ref-worker-", applyEnv: true });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("saves a chat secret beside an existing entry and rolls back only its own write", async () => {
  writeSecretStoreEntry({
    scope: team,
    name: "GATEWAY_REMOTE_TOKEN",
    value: "owned-elsewhere",
    kind: "secret",
    updatedBy: "cli",
  });

  const write = await writeSecretStoreEntryForConfigRef({
    baseName: "GATEWAY_REMOTE_TOKEN",
    value: "from-chat",
    updatedBy: "openclaw",
    assertCurrent: () => {},
  });

  expect(write.name).toBe("GATEWAY_REMOTE_TOKEN_2");
  expect(readSecretStoreValue({ scope: team, name: write.name })).toEqual({
    ok: true,
    value: "from-chat",
  });
  expect(await write.rollback()).toBe(true);
  expect(listSecretStoreEntries({ scope: team }).map((entry) => entry.name)).toEqual([
    "GATEWAY_REMOTE_TOKEN",
  ]);
  expect(readSecretStoreValue({ scope: team, name: "GATEWAY_REMOTE_TOKEN" })).toEqual({
    ok: true,
    value: "owned-elsewhere",
  });
});

it("writes nothing when the requester is revoked after the caller's check", async () => {
  let checks = 0;

  await expect(
    writeSecretStoreEntryForConfigRef({
      baseName: "GATEWAY_REMOTE_TOKEN",
      value: "from-chat",
      updatedBy: "openclaw",
      assertCurrent: () => {
        checks += 1;
        if (checks > 1) {
          throw new Error("requesting run is no longer active");
        }
      },
    }),
  ).rejects.toThrow("no longer active");

  expect(listSecretStoreEntries({ scope: team, includeDeleted: true })).toEqual([]);
});
