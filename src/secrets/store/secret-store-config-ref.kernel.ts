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
import { isMissingSecretStoreTableError } from "./secret-store-sqlite.js";

type SecretStoreDatabase = Pick<DB, "secret_store_entries">;
type SecretStoreKind = "secret" | "env";

const TEAM_SCOPE = { scopeKind: "team", scopeId: "" } as const;
/** `_999` must still fit the 128-character entry-name limit. */
const CONFIG_REF_NAME_BASE_MAX = 124;
const CONFIG_REF_NAME_MAX_SUFFIX = 999;

export type SecretStoreWriteSnapshot = {
  value: string;
  kind: SecretStoreKind;
  allowedHosts: string | null;
  updatedBy: string | null;
};

export type SecretStoreConfigRefWrite = {
  /** Preferred entry name derived from the config path. */
  baseName: string;
  value: string;
  writer: string;
  now: number;
};

export type SecretStoreRollbackWrite = {
  name: string;
  expectedUpdatedBy: string;
  previous?: SecretStoreWriteSnapshot;
  now: number;
};

/**
 * Saves a chat-provided secret for one config key in a fresh entry: the first
 * free `NAME`, `NAME_2`, ... Live entries are never overwritten, because
 * another config key or auth profile may use them. A recycled soft-deleted
 * name starts without the old entry's host grants. `admit` fences the write
 * with the requester's live authority at transaction and commit.
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
        const live = executeSqliteQueryTakeFirstSync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select("name")
            .where("scope_kind", "=", TEAM_SCOPE.scopeKind)
            .where("scope_id", "=", TEAM_SCOPE.scopeId)
            .where("name", "=", name)
            .where("deleted_at_ms", "is", null),
        );
        if (live) {
          continue;
        }
        executeSqliteQuerySync(
          sqlite,
          db
            .insertInto("secret_store_entries")
            .values({
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
            })
            .onConflict((conflict) =>
              conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet({
                value: input.value,
                kind: "secret",
                created_at_ms: input.now,
                updated_at_ms: input.now,
                updated_by: input.writer,
                deleted_at_ms: null,
                allowed_hosts: null,
              }),
            ),
        );
        admit?.("commit");
        return { name };
      }
      throw new Error(
        `Secret store entries ${base} through ${base}_${CONFIG_REF_NAME_MAX_SUFFIX} are all in use; remove unused entries and try again.`,
      );
    },
    databaseOptions,
    { operationLabel: "secrets.store.write-config-ref" },
  );
}

/** Undoes one owner-tagged write; a later writer's value is left alone. */
export function rollbackSecretStoreEntryWriteInDatabase(
  input: SecretStoreRollbackWrite,
  databaseOptions?: OpenClawStateDatabaseOptions,
): boolean {
  try {
    return runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const update =
          input.previous === undefined
            ? db
                .updateTable("secret_store_entries")
                .set({ deleted_at_ms: input.now, updated_at_ms: input.now })
            : db.updateTable("secret_store_entries").set({
                value: input.previous.value,
                kind: input.previous.kind,
                allowed_hosts: input.previous.allowedHosts,
                updated_at_ms: input.now,
                updated_by: input.previous.updatedBy,
                deleted_at_ms: null,
              });
        const result = executeSqliteQuerySync(
          sqlite,
          update
            .where("scope_kind", "=", TEAM_SCOPE.scopeKind)
            .where("scope_id", "=", TEAM_SCOPE.scopeId)
            .where("name", "=", input.name)
            .where("updated_by", "=", input.expectedUpdatedBy)
            .where("deleted_at_ms", "is", null),
        );
        return Number(result.numAffectedRows ?? 0n) === 1;
      },
      databaseOptions,
      { operationLabel: "secrets.store.rollback-write" },
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return false;
    }
    throw error;
  }
}
