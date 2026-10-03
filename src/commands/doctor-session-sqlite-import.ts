import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { note } from "../../packages/terminal-core/src/note.js";
import type { DoctorCompactionTranscriptTransform } from "../config/sessions/session-accessor.sqlite-import-stage.js";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import type { SessionStoreTarget as ResolvedSessionStoreTarget } from "../config/sessions/targets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareLegacyAcpMigrationSource } from "../infra/legacy-acp-migration-source.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  type MigrationArtifactIdentity,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  assertSafeSessionSqliteMigrationMove,
  canonicalMigrationFilePath,
  filterRestoreManifestTargets,
  hasSymbolicLinkInDirectoryPath,
  migrationMoveKey,
  readSessionSqliteMigrationManifest,
  updateMigrationManifestTarget,
  type ActiveSessionSqliteMigrationRun,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  assertTranscriptFileUnchanged,
  countTranscriptEventsForPath,
  createTranscriptEventReader,
  readOnlySqliteValidationSnapshot,
  readTranscriptFingerprint,
  resolveTargetSqlitePath,
  type ReadOnlySqliteValidationSnapshot,
} from "../infra/session-sqlite-migration-readers.js";
import { verifyCanonicalSessionTranscriptSources } from "../infra/session-sqlite-transcript-verification.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { backupDoctorSqliteDatabases } from "./doctor-migration-backup.js";
import {
  applyLegacyCompactionEventFacts,
  createLegacyCompactionTranscriptTransform,
  prepareLegacySessionCompactionHistory,
} from "./doctor-session-compaction-history.js";
import { readSessionCompactionRepairPreimage } from "./doctor-session-delivery-state.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import type { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";
import { normalizePersistedSessionEntryShape } from "./doctor/shared/session-entry-shape.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };
const SESSION_IMPORT_BATCH_SIZE = 256;

export async function importLegacySessionRecords(
  {
    target,
    env,
    expectedIndexIdentity,
    recoveryInventory,
    authority,
  }: {
    target: SessionStoreTarget;
    env: NodeJS.ProcessEnv;
    expectedIndexIdentity?: MigrationArtifactIdentity;
    recoveryInventory?: ReturnType<typeof collectRecoveryInventory>;
    authority?: DoctorSqliteMaintenanceAuthority;
  },
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
  activeRun?: ActiveSessionSqliteMigrationRun,
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  try {
    const requireEmptyStore = Boolean(
      recoveryInventory?.report.artifacts.some((artifact) =>
        ["unreadable-manifest", "manifest-directory-alias"].includes(artifact.reason),
      ),
    );
    const assertRestoredIndexCurrent = requireEmptyStore
      ? undefined
      : prepareRestoredSessionIndex({ target, env, expectedIndexIdentity, recoveryInventory });
    const compactionPlans = new Map(
      records.map((record) => [record, prepareLegacySessionCompactionHistory({ ...record.entry })]),
    );
    const eventFacts = [...compactionPlans.values()].flatMap((plan) => plan.eventFacts);
    const doctorCompactionTranscriptTransform =
      eventFacts.length > 0 ? createLegacyCompactionTranscriptTransform(eventFacts) : undefined;
    const compactionAdmission =
      eventFacts.length > 0
        ? await prepareCompactionImportDestination({
            target,
            env,
            records,
            sessionIds: [
              ...new Set([
                ...records.map((record) => record.entry.sessionId),
                ...eventFacts.map((fact) => fact.sessionId),
              ]),
            ],
            expectedIndexIdentity,
            authority,
          })
        : undefined;
    // Historical markers can follow their owning entry across batch boundaries.
    // Keep their content and canonical metadata in the same existing spooled transaction.
    const batchSize =
      requireEmptyStore || eventFacts.length > 0 ? records.length : SESSION_IMPORT_BATCH_SIZE;
    const importedTranscriptSources = new Set<string>();
    const existingSnapshot = readOnlySqliteValidationSnapshot(target);
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const pending = records.slice(offset, offset + batchSize).flatMap((record) => {
        const prepared = prepareLegacySessionImport(
          target,
          record,
          report,
          importedTranscriptSources,
          existingSnapshot.ok ? existingSnapshot.snapshot : undefined,
          env,
          compactionPlans.get(record)!,
          doctorCompactionTranscriptTransform,
        );
        if (!prepared && compactionPlans.get(record)!.eventFacts.length > 0) {
          throw new Error(`Compaction history source could not be imported: ${record.sessionKey}`);
        }
        return prepared ? [{ ...prepared, params: { ...prepared.params, env }, record }] : [];
      });
      const imported = await importSqliteSessionRowsBatch(
        pending.map((entry, index) => ({
          ...entry.params,
          requireEmptyStore,
          historicalOnly: entry.params.historicalOnly || Boolean(assertRestoredIndexCurrent),
          ...(index === 0 && (assertRestoredIndexCurrent || compactionAdmission)
            ? {
                beforePersistentApply: () => {
                  assertRestoredIndexCurrent?.();
                  compactionAdmission?.assertSourcesCurrent();
                },
              }
            : {}),
        })),
        eventFacts.length > 0
          ? {
              applyDoctorCompactionHistory: (database) => {
                compactionAdmission?.assertDestinationCurrent();
                applyLegacyCompactionEventFacts(database, eventFacts);
                compactionAdmission?.assertDestinationCurrent();
              },
            }
          : undefined,
      );
      for (const [index, result] of imported.entries()) {
        const record = pending[index]?.record;
        const recovery = pending[index]?.recovery ?? result.recovery;
        if (record && recovery) {
          record.recovery = recovery;
        }
      }
      report.importedEntries += imported.length;
      report.importedTranscriptEvents += imported.reduce(
        (total, result) => total + result.transcriptEvents,
        0,
      );
      report.issues.push(...pending.flatMap((entry) => (entry.issue ? [entry.issue] : [])));
      await setImmediate();
    }
  } catch (error) {
    const failures = [error];
    report.issues.push({ code: "sqlite_import_failed", message: formatErrorMessage(error) });
    if (activeRun) {
      activeRun.manifest.failedAt = new Date().toISOString();
      try {
        updateMigrationManifestTarget(activeRun, report, report.issues);
      } catch (recordError) {
        failures.push(recordError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${formatErrorMessage(error)}; could not record session SQLite migration failure: ${formatErrorMessage(failures[1])}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function prepareCompactionImportDestination(params: {
  target: SessionStoreTarget;
  env: NodeJS.ProcessEnv;
  records: readonly LegacySessionRecord[];
  sessionIds: readonly string[];
  expectedIndexIdentity?: MigrationArtifactIdentity;
  authority?: DoctorSqliteMaintenanceAuthority;
}) {
  const sqlitePath = resolveTargetSqlitePath(params.target, params.env);
  const identity = readDatabasePathIdentitySync(sqlitePath);
  const existing = identity.key.startsWith("file:");
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const authority =
    params.authority ??
    (maintenance?.ownsSchemaMaintenance
      ? { assertCurrent: () => maintenance.assertAdmission() }
      : undefined);
  if (existing && !authority) {
    throw new Error("Compaction history import requires Doctor maintenance ownership.");
  }
  const assertDestinationCurrent = () => {
    authority?.assertCurrent();
    if (existing) {
      assertExistingDatabaseIdentity(sqlitePath, identity.key, identity.birthtime);
    }
  };
  const indexIdentity =
    params.expectedIndexIdentity ??
    (fs.existsSync(params.target.storePath)
      ? readMigrationArtifactIdentity(params.target.storePath)
      : undefined);
  const transcriptSources = new Map(
    params.records.flatMap((record) =>
      record.transcriptPath && fs.existsSync(record.transcriptPath)
        ? [[record.transcriptPath, readTranscriptFingerprint(record.transcriptPath)] as const]
        : [],
    ),
  );
  const assertSourcesCurrent = () => {
    assertDestinationCurrent();
    if (
      indexIdentity &&
      !sameMigrationArtifact(indexIdentity, readMigrationArtifactIdentity(params.target.storePath))
    ) {
      throw new Error(`Compaction history source changed: ${params.target.storePath}`);
    }
    for (const [source, fingerprint] of transcriptSources) {
      assertTranscriptFileUnchanged(source, fingerprint);
    }
  };
  assertSourcesCurrent();
  if (existing) {
    const sessionKeys = params.records.map((record) => record.sessionKey);
    const sourcePath = fs.realpathSync.native(sqlitePath);
    const preimage = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        readSessionCompactionRepairPreimage(database.db, sessionKeys, params.sessionIds),
      { agentId: params.target.agentId, path: sqlitePath, env: params.env },
    );
    if (!preimage.found) {
      throw new Error(
        `Session database unavailable before compaction import backup: ${preimage.reason}`,
      );
    }
    // Original JSONL does not preserve preexisting destination metrics or cold archives.
    const backup = await backupDoctorSqliteDatabases({
      env: params.env,
      pendingDatabasePaths: [sqlitePath],
      databasePaths: [sqlitePath],
      authority: { assertCurrent: assertDestinationCurrent },
      repair: {
        key: randomUUID(),
        validate: (database, currentSourcePath) => {
          if (
            currentSourcePath === sourcePath &&
            readSessionCompactionRepairPreimage(database, sessionKeys, params.sessionIds)
              .fingerprint !== preimage.value.fingerprint
          ) {
            throw new Error(
              `Compaction import backup differs from the planned source: ${sourcePath}`,
            );
          }
        },
      },
    });
    assertSourcesCurrent();
    const backupMessages = [...backup.changes, ...backup.warnings];
    if (backupMessages.length > 0) {
      note(backupMessages.map((message) => `- ${message}`).join("\n"), "Session SQLite backups");
    }
    const cold = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        params.sessionIds.filter((sessionId) => readSessionColdTranscript(database.db, sessionId)),
      { agentId: params.target.agentId, path: sqlitePath, env: params.env },
    );
    if (!cold.found) {
      throw new Error(
        `Session database unavailable after compaction import backup: ${cold.reason}`,
      );
    }
    if (cold.value.length > 0) {
      const { restoreSessionColdTranscript } =
        await import("../config/sessions/session-cold-storage.js");
      assertSourcesCurrent();
      for (const sessionId of cold.value) {
        await restoreSessionColdTranscript(
          { agentId: params.target.agentId, storePath: sqlitePath, sessionId, env: params.env },
          assertDestinationCurrent,
        );
        assertSourcesCurrent();
      }
    }
  }
  return { assertSourcesCurrent, assertDestinationCurrent };
}

function prepareRestoredSessionIndex(params: {
  target: SessionStoreTarget;
  env: NodeJS.ProcessEnv;
  expectedIndexIdentity?: MigrationArtifactIdentity;
  recoveryInventory?: ReturnType<typeof collectRecoveryInventory>;
}): (() => void) | undefined {
  const { expectedIndexIdentity, recoveryInventory, target } = params;
  if (!expectedIndexIdentity || !recoveryInventory) {
    return undefined;
  }
  const storePath = canonicalMigrationFilePath(target.storePath);
  const sqlitePath = resolveTargetSqlitePath(target, params.env);
  const receipts = new Map<string, MigrationArtifactIdentity>();
  let hasSelectedOwner = false;
  for (const refs of recoveryInventory.references.values()) {
    for (const ref of refs) {
      if (
        ref.move.kind !== "legacy-store" ||
        ref.move.sourcePath !== storePath ||
        (!ref.consumedByRestore &&
          !ref.run.manifest.restore?.restoredFiles.includes(storePath) &&
          !ref.target.completedMoves.some(
            (move) => migrationMoveKey(move) === migrationMoveKey(ref.move),
          ))
      ) {
        continue;
      }
      const artifact = ref.move.artifact;
      if (!artifact) {
        throw new Error(`Restored session index has no recorded identity: ${storePath}`);
      }
      // A newly created legacy index is a different source, even at the same path.
      if (
        artifact.identity.dev !== expectedIndexIdentity.dev ||
        artifact.identity.ino !== expectedIndexIdentity.ino
      ) {
        continue;
      }
      // Shared originals have several owners; explicit restore admission also covers
      // custom stores outside automatic cleanup discovery.
      const selectedOwner = filterRestoreManifestTargets(ref.run.manifest, [
        { agentId: target.agentId, storePath, sqlitePath },
      ]).includes(ref.target);
      if (
        !sameMigrationArtifact(artifact.identity, expectedIndexIdentity) ||
        !ref.consumedByRestore ||
        ref.target.storePath !== storePath ||
        (ref.target.agentId === target.agentId && !selectedOwner) ||
        artifact.disposal.state !== "retained"
      ) {
        throw new Error(`Restored session index evidence cannot be verified: ${storePath}`);
      }
      assertSafeSessionSqliteMigrationMove(ref.move, ref.target);
      const identity = readMigrationArtifactIdentity(ref.run.manifestPath);
      if (
        JSON.stringify(readSessionSqliteMigrationManifest(ref.run.manifestPath)) !==
          JSON.stringify(ref.run.manifest) ||
        !sameMigrationArtifact(identity, readMigrationArtifactIdentity(ref.run.manifestPath))
      ) {
        throw new Error(`Session restore receipt changed: ${ref.run.manifestPath}`);
      }
      receipts.set(ref.run.manifestPath, identity);
      hasSelectedOwner ||= selectedOwner;
    }
  }
  if (receipts.size === 0) {
    return undefined;
  }
  if (!hasSelectedOwner) {
    throw new Error(`Restored session index evidence cannot be verified: ${storePath}`);
  }
  // A per-file restore can succeed during a partial or failed run. It proves provenance,
  // not permission to replace the current node; the import transaction preserves that owner.
  const assertCurrent = () => {
    for (const filePath of [storePath, sqlitePath, ...receipts.keys()]) {
      if (hasSymbolicLinkInDirectoryPath(path.dirname(filePath))) {
        throw new Error(`Session restore path changed: ${filePath}`);
      }
    }
    for (const [filePath, identity] of [[storePath, expectedIndexIdentity] as const, ...receipts]) {
      if (!sameMigrationArtifact(identity, readMigrationArtifactIdentity(filePath))) {
        throw new Error(`Session restore source or receipt changed: ${filePath}`);
      }
    }
  };
  assertCurrent();
  return assertCurrent;
}

function prepareLegacySessionImport(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  importedTranscriptSources: Set<string>,
  existingSnapshot: ReadOnlySqliteValidationSnapshot | undefined,
  env: NodeJS.ProcessEnv,
  compactionPlan: ReturnType<typeof prepareLegacySessionCompactionHistory>,
  doctorCompactionTranscriptTransform: DoctorCompactionTranscriptTransform | undefined,
) {
  if (
    record.historical &&
    record.transcriptPath &&
    !sameMigrationArtifact(
      record.historical.identity,
      readMigrationArtifactIdentity(record.transcriptPath),
    )
  ) {
    report.issues.push({
      code: "historical_transcript_deferred",
      sessionKey: record.sessionKey,
      message: `${record.historical.originalPath}: source changed after discovery; retained without importing`,
    });
    return undefined;
  }
  const transcriptSourceKey = record.transcriptPath
    ? `${record.entry.sessionId}\0${record.transcriptPath}`
    : undefined;
  const transcriptFingerprint =
    transcriptSourceKey !== undefined &&
    !importedTranscriptSources.has(transcriptSourceKey) &&
    record.transcriptPath &&
    fs.existsSync(record.transcriptPath)
      ? readTranscriptFingerprint(record.transcriptPath)
      : undefined;
  record.sourceFingerprint = transcriptFingerprint;
  const result = countTranscriptEventsForPath(record.transcriptPath);
  const transcriptMtimeMs = readLegacyTranscriptMtimeMs(record);
  const entry = normalizePersistedSessionEntryShape(compactionPlan.entry, {
    sessionKey: record.sessionKey,
  });
  if (!entry) {
    throw new Error(`Invalid legacy session entry: ${record.sessionKey}`);
  }
  const acpEntry = !record.historical ? entry : undefined;
  const params = {
    historicalOnly: Boolean(record.historical),
    allowMalformedRowRepair: true,
    repairLegacyTranscript: true,
    agentId: target.agentId,
    entry,
    doctorCompactionTranscriptTransform,
    ...(acpEntry?.acp
      ? {
          legacyAcpMigrationSource: prepareLegacyAcpMigrationSource({
            sourcePath: target.storePath,
            sourceSessionKey: record.sessionKey,
            sessionId: acpEntry.sessionId,
            lifecycleRevision: acpEntry.lifecycleRevision,
            meta: acpEntry.acp,
          }),
        }
      : {}),
    preserveExactStoredKey: true,
    sessionKey: record.sessionKey,
    storePath: target.sqlitePath ?? target.storePath,
  };
  let recovery: LegacySessionRecord["recovery"];
  if (result.status === "missing") {
    if (
      !Object.hasOwn(record.entry, "compactionCheckpoints") &&
      markAlreadyMigratedTranscript(record, report, existingSnapshot)
    ) {
      return undefined;
    }
    return {
      issue: {
        code: "transcript_missing",
        message: `Transcript file is missing: ${record.transcriptPath}`,
        sessionKey: record.sessionKey,
      },
      params,
      recovery,
    };
  }
  if (
    result.status === "ok" &&
    transcriptFingerprint &&
    record.transcriptPath &&
    (existingSnapshot?.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0) > 0
  ) {
    try {
      const verified = verifyCanonicalSessionTranscriptSources({
        target: { ...target, sqlitePath: report.sqlitePath },
        sources: [
          {
            path: record.transcriptPath,
            sessionId: record.entry.sessionId,
            originalPath: record.historical?.originalPath ?? record.transcriptPath,
            doctorCompactionTranscriptTransform,
          },
        ],
        env,
        mode: "appendable",
      });
      if (!verified) {
        throw new Error(
          "Missing history requires legacy format or branch repair before it can be appended",
        );
      }
      if (verified.missingEvents === 0) {
        recovery = {
          complete: true,
          repaired: false,
          events: verified.events,
          sqliteEvents: verified.sqliteEvents,
        };
      }
    } catch (error) {
      report.issues.push({
        code: "sqlite_transcript_count_mismatch",
        sessionKey: record.sessionKey,
        message: `${record.transcriptPath}: ${formatErrorMessage(error)}. Original retained. Compare the named events with a verified backup, restore a corrected JSONL at this path, then rerun openclaw doctor --session-sqlite recover.`,
      });
      return undefined;
    }
  }
  if (transcriptSourceKey) {
    importedTranscriptSources.add(transcriptSourceKey);
  }
  return {
    recovery,
    ...(result.status === "malformed"
      ? {
          issue: {
            code: "transcript_malformed" as const,
            message: result.message,
            sessionKey: record.sessionKey,
          },
        }
      : {}),
    params: {
      ...params,
      ...(record.transcriptPath && transcriptFingerprint
        ? {
            readTranscriptEvents: createTranscriptEventReader(
              record.transcriptPath,
              record.entry.sessionId,
              result.status === "malformed",
              transcriptFingerprint,
              record.historical?.originalPath ?? record.transcriptPath,
              { preserveEventJson: doctorCompactionTranscriptTransform !== undefined },
            ),
          }
        : {}),
      ...(transcriptMtimeMs !== undefined ? { transcriptMtimeMs } : {}),
    },
  };
}

function markAlreadyMigratedTranscript(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
): boolean {
  if (
    !snapshot ||
    snapshot.sessionIdsBySessionKey.get(record.sessionKey) !== record.entry.sessionId
  ) {
    return false;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents +=
    snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
  return true;
}

function readLegacyTranscriptMtimeMs(record: LegacySessionRecord): number | undefined {
  if (!record.transcriptPath) {
    return undefined;
  }
  try {
    const mtimeMs = Math.floor(fs.statSync(record.transcriptPath).mtimeMs);
    return Number.isFinite(mtimeMs) && mtimeMs >= 0 ? mtimeMs : undefined;
  } catch {
    return undefined;
  }
}
