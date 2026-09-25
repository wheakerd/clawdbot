import { ENV_SECRET_REF_ID_RE } from "../../config/types.secrets.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

type SecretStoreDatabase = Pick<DB, "secret_store_entries">;

const TEAM_SCOPE = { scopeKind: "team", scopeId: "" } as const;
/** `_999` must still fit the 128-character entry-name limit. */
const CONFIG_REF_NAME_BASE_MAX = 124;
const CONFIG_REF_NAME_MAX_SUFFIX = 999;

export type SecretStoreConfigRefWrite = {
  /** Preferred entry name derived from the config path. */
  baseName: string;
  value: string;
  writer: string;
  now: number;
};

/**
 * Saves a chat-provided secret for one config key in a brand-new entry: the
 * first unused `NAME`, `NAME_2`, ... No existing row is touched, live or
 * soft-deleted, because a config key or auth profile may still point at it.
 * `admit` fences the write with the requester's live authority at transaction
 * and commit.
 */
export function writeSecretStoreEntryForConfigRefInDatabase(
  input: SecretStoreConfigRefWrite,
  databaseOptions?: OpenClawStateDatabaseOptions,
  admit?: (stage: "transaction" | "commit") => void,
): { name: string } {
  const base = input.baseName.slice(0, CONFIG_REF_NAME_BASE_MAX);
  if (!ENV_SECRET_REF_ID_RE.test(base)) {
    throw new Error(`Secret store name "${base}" is invalid.`);
  }
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      admit?.("transaction");
      ensureSecretStoreSchema(sqlite);
      const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
      for (let suffix = 1; suffix <= CONFIG_REF_NAME_MAX_SUFFIX; suffix += 1) {
        const name = suffix === 1 ? base : `${base}_${suffix}`;
        const taken = executeSqliteQueryTakeFirstSync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select("name")
            .where("scope_kind", "=", TEAM_SCOPE.scopeKind)
            .where("scope_id", "=", TEAM_SCOPE.scopeId)
            .where("name", "=", name),
        );
        if (taken) {
          continue;
        }
        executeSqliteQuerySync(
          sqlite,
          db.insertInto("secret_store_entries").values({
            scope_kind: TEAM_SCOPE.scopeKind,
            scope_id: TEAM_SCOPE.scopeId,
            name,
            value: input.value,
            kind: "secret",
            created_at_ms: input.now,
            updated_at_ms: input.now,
            updated_by: input.writer,
            deleted_at_ms: null,
            allowed_hosts: null,
          }),
        );
        admit?.("commit");
        return { name };
      }
      throw new Error(
        `Secret store entries ${base} through ${base}_${CONFIG_REF_NAME_MAX_SUFFIX} are all taken; remove unused entries with openclaw secrets store rm and try again.`,
      );
    },
    databaseOptions,
    { operationLabel: "secrets.store.write-config-ref" },
  );
}
