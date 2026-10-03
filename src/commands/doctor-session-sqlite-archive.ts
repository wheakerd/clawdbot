/** Plans and publishes Doctor archive moves through the migration receipt owner. */
import fs from "node:fs";
import path from "node:path";
import {
  resolveTrajectoryPath,
  resolveTrajectoryPointerPath,
} from "../config/sessions/artifacts.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { resolveRealpathOrAbsolute as canonicalFilePath } from "../infra/boundary-path.js";
import { DeferredPluginMigrationConflictError } from "../infra/deferred-plugin-migrations.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  moveMigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  HISTORICAL_IMPORT_REASON,
  assertSafeSessionSqliteMigrationMove,
  assertSafeSessionSqliteMigrationDirectory,
  canonicalMigrationFilePath,
  recordPlannedMigrationMoves,
  recordCompletedMigrationMoves,
  updateMigrationManifestTarget,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationMoveKind,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  listUnreferencedJsonlFiles,
  type gatherLegacyArchiveCoverage,
} from "./doctor-session-sqlite-discovery.js";
import {
  countBlockingSessionSqliteIssues,
  type LegacyArchiveTarget,
} from "./doctor-session-sqlite-types.js";

export function planImportedTranscriptArtifactsToArchive(
  target: SessionStoreTarget,
  sessionKey: string,
  transcriptPath: string,
  reservedArchivePaths: Set<string>,
  capturedSources?: ReadonlySet<string>,
): SessionSqliteMigrationMove[] {
  const moves: SessionSqliteMigrationMove[] = [];
  const addMove = (sourcePathRaw: string, kind: SessionSqliteMigrationMoveKind) => {
    if (capturedSources && !capturedSources.has(canonicalMigrationFilePath(sourcePathRaw))) {
      return;
    }
    const move = planSessionJsonlArchiveMove({
      archiveKey: sessionKey,
      baseNameRaw: path.basename(sourcePathRaw),
      kind,
      reservedArchivePaths,
      sessionKey,
      sourcePathRaw,
      target,
    });
    reservedArchivePaths.add(move.archivePath);
    moves.push(move);
  };
  addMove(transcriptPath, "transcript");
  const trajectoryPath = resolveTrajectoryPath(transcriptPath);
  if (trajectoryPath && fs.existsSync(trajectoryPath)) {
    addMove(trajectoryPath, "trajectory");
  }
  const trajectoryPointerPath = resolveTrajectoryPointerPath(transcriptPath);
  if (trajectoryPointerPath && fs.existsSync(trajectoryPointerPath)) {
    addMove(trajectoryPointerPath, "trajectory");
  }
  return moves;
}

export function planSessionJsonlArchiveMove(params: {
  archiveKey: string;
  baseNameRaw: string;
  kind: SessionSqliteMigrationMoveKind;
  reservedArchivePaths?: ReadonlySet<string>;
  sessionKey?: string;
  sourcePathRaw: string;
  target: SessionStoreTarget;
}): SessionSqliteMigrationMove {
  const sourcePathRaw = path.resolve(params.sourcePathRaw);
  const stat = fs.lstatSync(sourcePathRaw);
  if (!stat.isFile()) {
    throw new Error("source is not a regular file");
  }
  const sourcePath = path.join(
    canonicalFilePath(path.dirname(sourcePathRaw)),
    path.basename(sourcePathRaw),
  );
  const sessionsDir = canonicalFilePath(path.dirname(path.resolve(params.target.storePath)));
  if (path.dirname(sourcePath) !== sessionsDir) {
    throw new Error(`Migration source is outside the target sessions directory: ${sourcePath}`);
  }
  const archiveDir = resolveImportedTranscriptArchiveDir(params.target.storePath);
  assertSafeSessionSqliteMigrationDirectory(archiveDir);
  fs.mkdirSync(archiveDir, { recursive: true });
  assertSafeSessionSqliteMigrationDirectory(archiveDir);
  const baseName = params.baseNameRaw.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 160) || "artifact";
  const keySlug = params.archiveKey.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "session";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `.${attempt}`;
    const archivePath = path.join(
      archiveDir,
      `${keySlug}.${baseName}.imported-${Date.now()}${suffix}`,
    );
    if (fs.existsSync(archivePath) || params.reservedArchivePaths?.has(archivePath)) {
      continue;
    }
    return {
      archivePath,
      kind: params.kind,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      sourcePath,
    };
  }
  throw new Error(`Could not archive ${baseName} for ${params.archiveKey}`);
}

function resolveImportedTranscriptArchiveDir(storePath: string): string {
  const storeDir = canonicalFilePath(path.dirname(path.resolve(storePath)));
  return path.join(path.dirname(storeDir), "session-sqlite-import-archive");
}

export async function archiveImportedLegacySessionStores(
  owners: readonly LegacyArchiveTarget[],
  activeRun: ActiveSessionSqliteMigrationRun,
  coverage: ReturnType<typeof gatherLegacyArchiveCoverage>,
  assertCurrent?: () => void,
  publishSourceRemoval?: (remove: () => void, retainSource: () => void) => void,
): Promise<void> {
  const byStore = new Map<string, LegacyArchiveTarget[]>();
  for (const owner of owners) {
    const storePath = owner.target.storePath;
    byStore.set(storePath, [...(byStore.get(storePath) ?? []), owner]);
  }
  for (const [storePath, entries] of byStore) {
    assertCurrent?.();
    // A historical-only target may never have had an index; losing an admitted index is a failure.
    if (!coverage.indexIdentities.has(storePath) && !fs.existsSync(storePath)) {
      continue;
    }
    if (
      !coverage.selectedStorePaths.has(storePath) ||
      entries.some(
        ({ report }) =>
          countBlockingSessionSqliteIssues(report) > 0 ||
          report.issues.some((issue) => issue.code === "active_sqlite_transcript_jsonl"),
      )
    ) {
      continue;
    }
    const first = entries[0]!;
    let publicationPlanned = false;
    try {
      const expected = coverage.indexIdentities.get(storePath);
      if (!expected || !sameMigrationArtifact(readMigrationArtifactIdentity(storePath), expected)) {
        throw new Error("Session index changed after import; retaining the unverified original");
      }
      const move = planSessionJsonlArchiveMove({
        archiveKey: "legacy-store",
        baseNameRaw: path.basename(storePath),
        kind: "legacy-store",
        sourcePathRaw: storePath,
        target: first.target,
      });
      const manifestTargets = activeRun.manifest.targets.filter(
        (target) => target.storePath === storePath,
      );
      const transcripts = manifestTargets.flatMap((target) =>
        target.plannedMoves.filter((item) => item.kind === "transcript"),
      );
      const complete =
        entries.every(
          ({ validated, report }) =>
            validated &&
            report.issues.every((issue) => issue.code === "historical_duplicate_settled"),
        ) && transcripts.every((item) => item.artifact?.classification !== "protected");
      const dependencies = entries
        .flatMap(({ records }) => records.flatMap((record) => record.transcriptDependencies))
        .map(canonicalMigrationFilePath);
      move.artifact = {
        identity: expected,
        classification: complete ? "imported" : "protected",
        reason: complete ? "verified-index-import" : "incomplete-index-import",
        dependencies: [...new Set(dependencies)],
        disposal: { state: "retained" },
      };
      for (const { target } of entries) {
        assertCurrent?.();
        recordPlannedMigrationMoves(activeRun, target, [move]);
        assertSafeSessionSqliteMigrationMove(move, target);
      }
      publicationPlanned = true;
      assertCurrent?.();
      await moveMigrationArtifact(
        move.sourcePath,
        move.archivePath,
        expected,
        assertCurrent
          ? () => {
              assertCurrent();
            }
          : undefined,
        publishSourceRemoval,
      );
      assertCurrent?.();
      for (const { target, report } of entries) {
        recordCompletedMigrationMoves(activeRun, target, [move]);
        report.archivedLegacyStoreFiles!.push(move.archivePath);
      }
    } catch (error) {
      if (error instanceof DeferredPluginMigrationConflictError && error.pending.length > 0) {
        break;
      }
      for (const { report, target } of entries) {
        report.issues.push({
          code: "legacy_store_archive_failed",
          message: `${storePath}: ${formatErrorMessage(error)}`,
        });
        // A recorded index plan already protects its dependencies and can reconcile on retry.
        // Earlier failures have no artifact record, so retain that failure on the owner instead.
        if (!publicationPlanned) {
          assertCurrent?.();
          updateMigrationManifestTarget(activeRun, target, report.issues);
        }
      }
    }
  }
}

export async function archiveLegacyArtifacts(
  owners: readonly LegacyArchiveTarget[],
  coverage: ReturnType<typeof gatherLegacyArchiveCoverage>,
  activeRun: ActiveSessionSqliteMigrationRun,
  assertCurrent?: () => void,
  capturedSources?: ReadonlySet<string>,
  publishSourceRemoval?: (remove: () => void, retainSource: () => void) => void,
): Promise<void> {
  const {
    selectedStorePaths,
    referencedPaths,
    retainedPaths,
    incompleteDirectories,
    retainedDirectories,
  } = coverage;
  const references = new Map<
    string,
    Array<{ owner: LegacyArchiveTarget; record: LegacyArchiveTarget["records"][number] }>
  >();
  for (const owner of owners) {
    if (!owner.validated || countBlockingSessionSqliteIssues(owner.report) > 0) {
      selectedStorePaths.delete(owner.target.storePath);
    }
    for (const record of owner.records) {
      if (!record.transcriptPath) {
        continue;
      }
      const source = canonicalMigrationFilePath(record.transcriptPath);
      references.set(source, [...(references.get(source) ?? []), { owner, record }]);
    }
  }
  // A retained index needs all its originals. Propagate through shared sources before planning,
  // so a direct retry cannot strand a sibling archive without its index.
  const retainedSources = [...references]
    .filter(
      ([source, refs]) =>
        retainedPaths.has(source) ||
        retainedDirectories.has(path.dirname(source)) ||
        refs.some(({ owner }) => !selectedStorePaths.has(owner.target.storePath)),
    )
    .map(([source]) => source);
  for (const source of retainedSources) {
    for (const file of [
      source,
      resolveTrajectoryPath(source),
      resolveTrajectoryPointerPath(source),
    ]) {
      if (file) {
        retainedPaths.add(file);
      }
    }
    for (const { owner } of references.get(source) ?? []) {
      const storePath = owner.target.storePath;
      if (!selectedStorePaths.delete(storePath)) {
        continue;
      }
      for (const sibling of owners.filter((item) => item.target.storePath === storePath)) {
        for (const record of sibling.records) {
          if (!record.transcriptPath) {
            continue;
          }
          const siblingSource = canonicalMigrationFilePath(record.transcriptPath);
          if (!retainedPaths.has(siblingSource)) {
            retainedPaths.add(siblingSource);
            retainedSources.push(siblingSource);
          }
        }
      }
    }
  }
  const reservedArchivePaths = new Set<string>();
  const planned = new Map<
    string,
    { move: SessionSqliteMigrationMove; owners: Map<LegacyArchiveTarget, string | undefined> }
  >();
  const recordFailure = (
    owner: LegacyArchiveTarget,
    source: string,
    error: unknown,
    unreferenced = false,
  ) => {
    owner.report.issues.push({
      code: unreferenced ? "unreferenced_jsonl_archive_failed" : "transcript_archive_failed",
      message: `${source}: ${formatErrorMessage(error)}`,
    });
  };
  for (const [source, refs] of references) {
    const first = refs[0]!;
    if (!fs.existsSync(source)) {
      // Only initially missing sources may be skipped. Losing an admitted original must
      // protect every referencing index and its remaining recovery dependencies.
      if (refs.some(({ record }) => record.sourceFingerprint)) {
        for (const owner of new Set(refs.map((ref) => ref.owner))) {
          recordFailure(owner, source, "Imported transcript disappeared before archival");
        }
      }
      continue;
    }
    if (retainedPaths.has(source) || retainedDirectories.has(path.dirname(source))) {
      for (const { owner, record } of refs) {
        if (
          countBlockingSessionSqliteIssues(owner.report) === 0 &&
          owner.deferredPluginIds.length === 0
        ) {
          owner.report.issues.push({
            code: "transcript_archive_deferred",
            message: `${source}: retaining the original for an incomplete or unselected importing owner; rerun import for all known owners after resolving their index/import issues.`,
            sessionKey: record.sessionKey,
          });
        }
      }
      continue;
    }
    try {
      const moves = planImportedTranscriptArtifactsToArchive(
        first.owner.target,
        first.record.sessionKey,
        source,
        reservedArchivePaths,
        capturedSources,
      );
      // Same-session aliases reuse the actual importer evidence only within their validated target.
      const imports = refs.map(({ owner, record }) =>
        record.sourceFingerprint
          ? record
          : refs.find(
              (ref) =>
                ref.owner === owner &&
                ref.record.sessionId === record.sessionId &&
                ref.record.sourceFingerprint,
            )?.record,
      );
      const fingerprints = imports.flatMap((record) =>
        record?.sourceFingerprint ? [record.sourceFingerprint] : [],
      );
      const fingerprint = fingerprints[0];
      if (
        fingerprint &&
        fingerprints.some((current) =>
          (["ctimeNs", "dev", "ino", "mtimeNs", "size"] as const).some(
            (key) => current[key] !== fingerprint[key],
          ),
        )
      ) {
        throw new Error("Transcript changed between imports; retaining the unverified original");
      }
      const complete =
        !incompleteDirectories.has(path.dirname(source)) &&
        imports.every((record) => record?.sourceFingerprint && record.recovery?.complete) &&
        refs.every(
          ({ owner, record }) =>
            !owner.report.issues.some(
              (issue) =>
                issue.code === "transcript_malformed" && issue.sessionKey === record.sessionKey,
            ),
        );
      for (const move of moves) {
        if (retainedPaths.has(move.sourcePath)) {
          throw new Error("Artifact is required by an incomplete importing owner");
        }
        move.artifact = {
          identity: readMigrationArtifactIdentity(
            move.sourcePath,
            1n,
            move.kind === "transcript" ? fingerprint : undefined,
          ),
          classification:
            complete && move.kind === "transcript" && !first.record.historical
              ? imports.some((record) => record?.recovery?.repaired)
                ? "repair-original"
                : "imported"
              : "protected",
          reason:
            complete && first.record.historical && move.kind === "transcript"
              ? HISTORICAL_IMPORT_REASON
              : complete && move.kind === "transcript"
                ? "verified-import-original"
                : "unimported-or-unknown-history",
          ...(complete &&
          move.kind === "transcript" &&
          first.record.recovery?.sqliteEvents !== undefined
            ? {
                verification: `superseded by SQLite (${first.record.recovery.events} of ${first.record.recovery.sqliteEvents} events present)`,
              }
            : {}),
          dependencies: [],
          disposal: { state: "retained" },
        };
        const existing = planned.get(move.sourcePath);
        if (existing) {
          if (move.artifact.classification === "protected") {
            existing.move.artifact = move.artifact;
          }
          for (const ref of refs) {
            existing.owners.set(ref.owner, ref.record.sessionKey);
          }
        } else {
          planned.set(move.sourcePath, {
            move,
            owners: new Map(refs.map((ref) => [ref.owner, ref.record.sessionKey])),
          });
        }
      }
    } catch (error) {
      for (const owner of new Set(refs.map((ref) => ref.owner))) {
        recordFailure(owner, source, error);
      }
    }
  }
  // Gather all indexed sources and plans before sweeping any directory; another custom index
  // may own a file even when its importer failed or was not selected for this run.
  for (const owner of owners) {
    const storePath = owner.target.storePath;
    if (
      !selectedStorePaths.has(storePath) ||
      countBlockingSessionSqliteIssues(owner.report) > 0 ||
      incompleteDirectories.has(path.dirname(storePath))
    ) {
      continue;
    }
    const planUnreferencedMove = (source: string, kind: SessionSqliteMigrationMoveKind) => {
      try {
        const move = planSessionJsonlArchiveMove({
          archiveKey: "archive-tier",
          baseNameRaw: path.basename(source),
          kind,
          reservedArchivePaths,
          sourcePathRaw: source,
          target: owner.target,
        });
        move.artifact = {
          identity: readMigrationArtifactIdentity(source),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        };
        reservedArchivePaths.add(move.archivePath);
        planned.set(source, { move, owners: new Map([[owner, undefined]]) });
        return true;
      } catch (error) {
        recordFailure(owner, source, error, true);
        return false;
      }
    };
    const pointers = new Set<string>();
    const receiptSources = new Set(
      owner.retainedImportVerified
        ? (owner.verifiedSources ?? []).map((source) => source.path)
        : [],
    );
    for (const source of listUnreferencedJsonlFiles(storePath, [
      ...referencedPaths,
      ...planned.keys(),
    ])) {
      if (retainedPaths.has(source)) {
        continue;
      }
      if (
        (capturedSources && !capturedSources.has(source)) ||
        (owner.retainedImportVerified && !receiptSources.has(source))
      ) {
        continue;
      }
      const pointer = resolveTrajectoryPointerPath(source);
      if (planUnreferencedMove(source, "unreferenced-jsonl") && pointer) {
        pointers.add(pointer);
      }
    }
    // A pointer sidecar only locates its transcript's trajectory, so it settles with that
    // transcript, including a receipt-verified one an earlier run archived without it.
    for (const transcript of receiptSources) {
      const pointer = resolveTrajectoryPointerPath(transcript);
      if (
        pointer &&
        receiptSources.has(pointer) &&
        !owner.sourceConflicts?.has(transcript) &&
        !fs.existsSync(transcript)
      ) {
        pointers.add(pointer);
      }
    }
    for (const pointer of pointers) {
      const source = canonicalMigrationFilePath(pointer);
      if (
        fs.existsSync(source) &&
        !planned.has(source) &&
        !referencedPaths.has(source) &&
        !retainedPaths.has(source) &&
        !owner.sourceConflicts?.has(pointer) &&
        (!capturedSources || capturedSources.has(source))
      ) {
        planUnreferencedMove(source, "trajectory");
      }
    }
  }
  // A physical move must remain resolvable through every receipt that captured its source.
  for (const owner of owners) {
    for (const { path: source } of owner.verifiedSources ?? []) {
      const shared = planned.get(source);
      if (shared && !shared.owners.has(owner)) {
        shared.owners.set(owner, undefined);
      }
    }
  }
  const movesForOwner = (owner: LegacyArchiveTarget) =>
    [...planned.values()]
      .filter((item) => item.owners.has(owner))
      .map(({ move, owners: refs }) => Object.assign({}, move, { sessionKey: refs.get(owner) }));
  // Every referencing target gets its own session key and shared mapping before publication.
  for (const owner of owners) {
    assertCurrent?.();
    recordPlannedMigrationMoves(activeRun, owner.target, movesForOwner(owner));
  }
  const completed = new Set<string>();
  for (const { move, owners: referencingOwners } of planned.values()) {
    try {
      for (const owner of referencingOwners.keys()) {
        assertSafeSessionSqliteMigrationMove(move, owner.target);
      }
      assertCurrent?.();
      await moveMigrationArtifact(
        move.sourcePath,
        move.archivePath,
        move.artifact!.identity,
        assertCurrent
          ? () => {
              assertCurrent();
            }
          : undefined,
        publishSourceRemoval,
      );
      assertCurrent?.();
      completed.add(move.sourcePath);
      for (const { report } of referencingOwners.keys()) {
        (move.kind === "unreferenced-jsonl"
          ? report.archivedUnreferencedJsonlFiles
          : report.archivedTranscriptFiles
        ).push(move.archivePath);
      }
    } catch (error) {
      if (error instanceof DeferredPluginMigrationConflictError && error.pending.length > 0) {
        break;
      }
      for (const owner of referencingOwners.keys()) {
        recordFailure(owner, move.sourcePath, error, move.kind === "unreferenced-jsonl");
      }
    }
  }
  for (const owner of owners) {
    assertCurrent?.();
    recordCompletedMigrationMoves(
      activeRun,
      owner.target,
      movesForOwner(owner).filter((move) => completed.has(move.sourcePath)),
    );
    owner.report.unreferencedJsonlFiles = listUnreferencedJsonlFiles(owner.target.storePath, [
      ...referencedPaths,
    ]);
  }
}
