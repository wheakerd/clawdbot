import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { note } from "../../packages/terminal-core/src/note.js";
import { scanDoctorSessionEntriesTolerant } from "../config/sessions/session-accessor.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  hasLegacySessionEntryState,
  hasLegacySessionProviderState,
} from "../config/sessions/session-entry-state-format.js";
import { stripRuntimeOnlySessionSkillsFields } from "../config/sessions/store-entry-shape.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import {
  listExistingAgentDatabaseTargets,
  type ExistingAgentDatabaseTarget,
} from "../infra/session-sqlite-migration-readers.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import {
  createLegacyStateMigrationStepReceipt,
  DoctorStateMigrationRefusalError,
} from "../infra/state-migrations.messages.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "../state/openclaw-agent-db-migration-required.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { runDoctorAgentDatabaseOperation } from "./doctor-agent-database-operation.js";
import { backupDoctorSqliteDatabases } from "./doctor-migration-backup.js";
import {
  applyLegacyCompactionEventFacts,
  createLegacyCompactionTranscriptTransform,
  prepareLegacySessionCompactionHistory,
  type LegacyCompactionEventFact,
} from "./doctor-session-compaction-history.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";
import {
  rewriteDoctorSessionEntries,
  scanDoctorSessionEntryRecords,
} from "./doctor/shared/session-entry-rewrite.js";
import { migrateLegacySessionEntryState } from "./doctor/shared/session-entry-shape.js";

export type SessionDeliveryStateRepairReport = {
  found: number;
  repaired: number;
  scannedStores: number;
};

/** Scan or rewrite legacy delivery fields inside existing session row JSON. */
export function repairCanonicalSessionDeliveryStates(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets?: readonly ExistingAgentDatabaseTarget[];
}): SessionDeliveryStateRepairReport {
  return repairCanonicalSessionEntries({
    ...params,
    transform: normalizeLegacySessionEntryDelivery,
    updateDeliveryProjection: true,
  });
}

export function repairCanonicalSessionResolvedSkills(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets?: readonly ExistingAgentDatabaseTarget[];
}): SessionDeliveryStateRepairReport {
  return repairCanonicalSessionEntries({
    ...params,
    transform: stripRuntimeOnlySessionSkillsFields,
    updateDeliveryProjection: false,
  });
}

type SessionEntryRepairParams = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets?: readonly ExistingAgentDatabaseTarget[];
  transform: (entry: SessionEntry, sessionKey: string, phase: "scan" | "repair") => SessionEntry;
  updateDeliveryProjection: boolean;
};

type PreparedSessionEntryRepairParams =
  | (SessionEntryRepairParams & { source: "canonical" })
  | (Omit<SessionEntryRepairParams, "transform"> & {
      source: "raw";
      rawNeedsRepair: (entry: Record<string, unknown>) => boolean;
      rawTransform: (
        entry: Record<string, unknown>,
        sessionKey: string,
        updatedAt: number,
        database: OpenClawAgentDatabase,
      ) => Record<string, unknown>;
      deferSchemaRepair?: boolean;
    });

function prepareSessionEntryRepairs(params: PreparedSessionEntryRepairParams) {
  const targets = params.targets ?? listExistingAgentDatabaseTargets(params.cfg, params.env);
  const pending = targets.flatMap((target) => {
    const sessionKeys: string[] = [];
    const scope = { agentId: target.agentId, env: params.env, storePath: target.sqlitePath };
    const scan = () => {
      const identity = readDatabasePathIdentitySync(target.sqlitePath);
      if (params.source === "raw") {
        scanDoctorSessionEntryRecords(
          scope,
          ({ entry, sessionKey }) => {
            if (params.rawNeedsRepair(entry)) {
              sessionKeys.push(sessionKey);
            }
          },
          identity,
        );
      } else {
        scanDoctorSessionEntriesTolerant(
          scope,
          ({ entry, recoveredFromProjections, sessionKey }) => {
            if (
              !recoveredFromProjections &&
              params.transform(entry, sessionKey, "scan") !== entry
            ) {
              sessionKeys.push(sessionKey);
            }
          },
        );
      }
      assertExistingDatabaseIdentity(target.sqlitePath, identity.key, identity.birthtime);
      return { target, scope, sessionKeys, identity };
    };
    try {
      const operation =
        params.source === "raw"
          ? { ok: true, value: scan() }
          : runDoctorAgentDatabaseOperation({
              agentId: target.agentId,
              path: target.sqlitePath,
              run: scan,
            });
      return operation.ok && sessionKeys.length > 0 ? [operation.value] : [];
    } catch (error) {
      if (
        params.source === "raw" &&
        params.deferSchemaRepair &&
        (error instanceof SqliteSchemaMismatchError ||
          error instanceof OpenClawAgentDatabaseMediaMigrationRequiredError)
      ) {
        note(
          `- Session entry inspection awaits its database schema repair: ${formatErrorMessage(error)}`,
          "Session SQLite",
        );
        return [];
      }
      throw error;
    }
  });
  return {
    targets,
    pending,
    found: pending.reduce((count, item) => count + item.sessionKeys.length, 0),
    scannedStores: targets.length,
    apply(assertCurrent?: (target: ExistingAgentDatabaseTarget) => void): number {
      let repaired = 0;
      for (const { target, scope, sessionKeys, identity } of pending) {
        const wasOpen = isOpenClawAgentDatabaseOpen(target.sqlitePath);
        try {
          repaired += rewriteDoctorSessionEntries({
            scope,
            sessionKeys,
            ...(params.source === "raw"
              ? { rawTransform: params.rawTransform }
              : {
                  transform: (entry: SessionEntry, sessionKey: string) =>
                    params.transform(entry, sessionKey, "repair"),
                }),
            expectedIdentity: identity,
            updateDeliveryProjection: params.updateDeliveryProjection,
            ...(assertCurrent ? { assertCurrent: () => assertCurrent(target) } : {}),
          });
        } finally {
          if (!wasOpen) {
            closeOpenClawAgentDatabaseByPath(target.sqlitePath);
          }
        }
      }
      return repaired;
    },
  };
}

export function repairCanonicalSessionEntries(
  params: SessionEntryRepairParams & { apply: boolean },
): SessionDeliveryStateRepairReport {
  const plan = prepareSessionEntryRepairs({ ...params, source: "canonical" });
  return {
    found: plan.found,
    repaired: params.apply ? plan.apply() : 0,
    scannedStores: plan.scannedStores,
  };
}

/** Bind both compaction repair paths to the raw bytes their backup must preserve. */
export function readSessionCompactionRepairPreimage(
  database: DatabaseSync,
  sessionKeys: readonly string[],
  sessionIds: readonly string[],
): { fingerprint: string; entries: ReadonlyMap<string, string> } {
  return runSqliteDeferredTransactionSync(
    database,
    () => {
      const db = getSessionKysely(database);
      const digest = createHash("sha256");
      const hashRows = <Row extends object>(table: string, rows: Iterable<Row>) => {
        digest.update(table).update("\0");
        for (const row of rows) {
          for (const [field, value] of Object.entries(row)) {
            digest.update(field).update("\0");
            if (value instanceof Uint8Array) {
              digest.update(`blob:${value.byteLength}:`).update(value);
            } else {
              const serialized = JSON.stringify(value);
              if (serialized === undefined) {
                throw new Error("Session repair preimage contains an undefined SQLite value");
              }
              digest.update(serialized);
            }
            digest.update("\0");
          }
        }
      };
      const nodes = executeSqliteQuerySync(
        database,
        db
          .selectFrom("session_nodes")
          .selectAll()
          .where("session_key", "in", sqliteStringSet(sessionKeys))
          .orderBy("session_key"),
      ).rows;
      hashRows("nodes", nodes);
      hashRows(
        "snapshots",
        iterateSqliteQuerySync(
          database,
          db
            .selectFrom("session_entry_snapshots")
            .selectAll()
            .where("session_key", "in", sqliteStringSet(sessionKeys))
            .orderBy("session_key")
            .orderBy("field"),
        ),
      );
      hashRows(
        "windows",
        iterateSqliteQuerySync(
          database,
          db
            .selectFrom("session_windows")
            .selectAll()
            .where("session_id", "in", sqliteStringSet(sessionIds))
            .orderBy("session_id"),
        ),
      );
      hashRows(
        "events",
        iterateSqliteQuerySync(
          database,
          db
            .selectFrom("transcript_events")
            .selectAll()
            .where("session_id", "in", sqliteStringSet(sessionIds))
            .orderBy("session_id")
            .orderBy("seq"),
        ),
      );
      hashRows(
        "cold",
        iterateSqliteQuerySync(
          database,
          db
            .selectFrom("session_transcript_cold_archives")
            .selectAll()
            .where("session_id", "in", sqliteStringSet(sessionIds))
            .orderBy("session_id"),
        ),
      );
      return {
        fingerprint: digest.digest("hex"),
        entries: new Map(nodes.map((row) => [row.session_key, row.entry_json])),
      };
    },
    { operationLabel: "doctor.compaction-repair.preimage" },
  );
}

/** Raw repair and its backup precede all canonical session readers. */
export async function repairLegacySessionEntryStates(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authority?: DoctorSqliteMaintenanceAuthority;
  targets?: readonly ExistingAgentDatabaseTarget[];
  deferSchemaRepair?: boolean;
}): Promise<SessionDeliveryStateRepairReport> {
  try {
    const preparedFacts = new Map<string, Map<string, string>>();
    const preparedEntries = new Map<string, ReadonlyMap<string, string>>();
    const preparedTransforms = new Map<
      string,
      ReturnType<typeof createLegacyCompactionTranscriptTransform>
    >();
    const plan = prepareSessionEntryRepairs({
      ...params,
      source: "raw",
      rawNeedsRepair: hasLegacySessionEntryState,
      rawTransform: (entry, sessionKey, updatedAt, database) => {
        if (!hasLegacySessionEntryState(entry)) {
          return entry;
        }
        const raw = executeSqliteQueryTakeFirstSync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_nodes")
            .select("entry_json")
            .where("session_key", "=", sessionKey),
        );
        if (raw?.entry_json !== preparedEntries.get(database.path)?.get(sessionKey)) {
          throw new Error(`Session entry changed after backup preparation for ${sessionKey}`);
        }
        const next = migrateLegacySessionEntryState(entry, updatedAt);
        const prepared = prepareLegacySessionCompactionHistory(
          hasLegacySessionProviderState(entry) ? normalizeLegacySessionEntryDelivery(next) : next,
        );
        const fingerprint = JSON.stringify([
          prepared.entry.retainedHistoryReferences,
          prepared.eventFacts,
        ]);
        if (preparedFacts.get(database.path)?.get(sessionKey) !== fingerprint) {
          throw new Error(`Compaction history changed after backup preparation for ${sessionKey}`);
        }
        applyLegacyCompactionEventFacts(
          database,
          prepared.eventFacts,
          preparedTransforms.get(database.path),
        );
        return prepared.entry;
      },
      updateDeliveryProjection: true,
    });
    const report = { found: plan.found, repaired: 0, scannedStores: plan.scannedStores };
    if (!params.apply || plan.found === 0) {
      return report;
    }
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    const authority =
      params.authority ??
      (maintenance?.ownsSchemaMaintenance
        ? { assertCurrent: () => maintenance.assertAdmission() }
        : undefined);
    if (!authority) {
      throw new Error("Session entry state repair requires Doctor maintenance ownership.");
    }
    const identities = new Map(plan.pending.map(({ target, identity }) => [target, identity]));
    const assertTargetCurrent = (target: ExistingAgentDatabaseTarget) => {
      authority.assertCurrent();
      const identity = identities.get(target)!;
      assertExistingDatabaseIdentity(target.sqlitePath, identity.key, identity.birthtime);
    };
    const assertCurrent = () => {
      for (const target of identities.keys()) {
        assertTargetCurrent(target);
      }
    };
    const preimages = new Map<
      string,
      { sessionKeys: readonly string[]; sessionIds: string[]; fingerprint: string }
    >();
    for (const { target, scope, sessionKeys, identity } of plan.pending) {
      assertTargetCurrent(target);
      const selected = new Set(sessionKeys);
      const transcriptIds = new Set<string>();
      const eventFacts: LegacyCompactionEventFact[] = [];
      const fingerprints = new Map<string, string>();
      scanDoctorSessionEntryRecords(
        scope,
        ({ entry, sessionKey }) => {
          if (selected.has(sessionKey)) {
            const prepared = prepareLegacySessionCompactionHistory(entry);
            fingerprints.set(
              sessionKey,
              JSON.stringify([prepared.entry.retainedHistoryReferences, prepared.eventFacts]),
            );
            eventFacts.push(...prepared.eventFacts);
            for (const fact of prepared.eventFacts) {
              transcriptIds.add(fact.sessionId);
            }
          }
        },
        identity,
      );
      // Existing markers must agree across owner rows, including different rewrite batches.
      preparedTransforms.set(
        target.sqlitePath,
        createLegacyCompactionTranscriptTransform(eventFacts),
      );
      preparedFacts.set(target.sqlitePath, fingerprints);
      const sessionIds = [...transcriptIds];
      const preimage = withOpenClawAgentDatabaseReadOnly(
        (database) => readSessionCompactionRepairPreimage(database.db, sessionKeys, sessionIds),
        { agentId: target.agentId, path: target.sqlitePath, env: params.env },
      );
      if (!preimage.found) {
        throw new Error(`Session database unavailable before repair backup: ${preimage.reason}`);
      }
      preimages.set(realpathSync.native(target.sqlitePath), {
        sessionKeys,
        sessionIds,
        fingerprint: preimage.value.fingerprint,
      });
      preparedEntries.set(target.sqlitePath, preimage.value.entries);
      assertTargetCurrent(target);
    }
    const backup = await backupDoctorSqliteDatabases({
      env: params.env,
      pendingDatabasePaths: plan.pending.map(({ target }) => target.sqlitePath),
      databasePaths: plan.targets.map((target) => target.sqlitePath),
      authority: { assertCurrent },
      repair: {
        key: randomUUID(),
        validate: (database, sourcePath) => {
          const preimage = preimages.get(sourcePath);
          if (
            preimage &&
            readSessionCompactionRepairPreimage(database, preimage.sessionKeys, preimage.sessionIds)
              .fingerprint !== preimage.fingerprint
          ) {
            throw new Error(`Session repair backup differs from the planned source: ${sourcePath}`);
          }
        },
      },
    });
    assertCurrent();
    note(
      [...backup.changes, ...backup.warnings].map((message) => `- ${message}`).join("\n"),
      "Session SQLite backups",
    );
    for (const { target, scope } of plan.pending) {
      const preimage = preimages.get(realpathSync.native(target.sqlitePath))!;
      if (preimage.sessionIds.length > 0) {
        const { restoreSessionColdTranscript } =
          await import("../config/sessions/session-cold-storage.js");
        for (const sessionId of preimage.sessionIds) {
          await restoreSessionColdTranscript({ ...scope, sessionId }, () =>
            assertTargetCurrent(target),
          );
        }
      }
      assertTargetCurrent(target);
    }
    report.repaired = plan.apply(assertTargetCurrent);
    for (const { target, scope, identity } of plan.pending) {
      assertTargetCurrent(target);
      scanDoctorSessionEntryRecords(
        scope,
        ({ entry, sessionKey }) => {
          if (hasLegacySessionEntryState(entry)) {
            throw new Error(
              `Legacy session state remains in ${sessionKey}; original rows are backed up. Resolve the remaining row repair before retrying Doctor.`,
            );
          }
        },
        identity,
      );
      assertTargetCurrent(target);
    }
    note(
      `- Canonicalized entry state for ${report.repaired} durable session row(s).`,
      "Session SQLite",
    );
    return report;
  } catch (error) {
    const endpoints = [{ kind: "owner" as const, id: "session-entry-state" }];
    throw new DoctorStateMigrationRefusalError([
      createLegacyStateMigrationStepReceipt(
        {
          id: "session-entry-state",
          phase: "final",
          source: endpoints,
          target: endpoints,
          requiredness: "required",
          reversibility: "checkpoint-required",
        },
        { changes: [], warnings: [formatErrorMessage(error)] },
      ),
    ]);
  }
}
