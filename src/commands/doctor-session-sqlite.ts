import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../agents/agent-roster.js";
import {
  isLegacySessionRecordOwnedByTarget,
  shouldFilterLegacySessionRecordsByTarget,
} from "../config/sessions/legacy-store-inspection.js";
import type { SessionStoreTarget as ResolvedSessionStoreTarget } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DeferredPluginMigrationConflictError,
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  withDeferredPluginMigrationsCurrent,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import {
  captureDeferredPluginSessionSources,
  deferredPluginSessionStoreIds,
  readDeferredPluginSessionImport,
  recordDeferredPluginSessionImport,
  type DeferredPluginSessionImport,
} from "../infra/deferred-plugin-session-sources.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import type { DoctorSessionSqliteIssue } from "../infra/session-sqlite-migration-issues.js";
import {
  HISTORICAL_IMPORT_REASON,
  canonicalMigrationFilePath,
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  readOnlySqliteValidationSnapshot,
  readSqliteEntryCount,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import { normalizePluginId, normalizePluginsConfig } from "../plugins/config-state.js";
import { prepareActiveSqliteTranscriptSettlement } from "./doctor-session-sqlite-active.js";
import {
  archiveImportedLegacySessionStores,
  archiveLegacyArtifacts,
} from "./doctor-session-sqlite-archive.js";
import {
  appendActiveSqliteTranscriptFileIssues,
  appendRetainedPluginSessionSourceIssue,
  appendSqliteDbStats,
  compactSqliteDatabase,
  countLegacyTranscript,
  summarizeDoctorSessionSqliteReport,
} from "./doctor-session-sqlite-diagnostics.js";
import {
  collectHistoricalArchiveSources,
  discoverLegacyHistoricalTranscripts,
  gatherLegacyArchiveCoverage,
  listUnreferencedJsonlFiles,
  readLegacySessionRecords,
  readArchivedSessionOwnership,
  type HistoricalArchiveSources,
} from "./doctor-session-sqlite-discovery.js";
import { writeSessionSqliteMigrationFailureReports } from "./doctor-session-sqlite-failure.js";
import { importLegacySessionRecords } from "./doctor-session-sqlite-import.js";
import { createMissingSessionIndexVerifier } from "./doctor-session-sqlite-missing-index.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import type { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreDoctorSessionSqliteTargets } from "./doctor-session-sqlite-restore-report.js";
import { reconcileSessionSqliteMigrationPublications } from "./doctor-session-sqlite-restore.js";
import {
  archiveConflictingRetainedSessionSources,
  countRetainedSessionSources,
  prepareRetainedSessionImport,
  retireDeferredPluginSessionImport,
} from "./doctor-session-sqlite-retained.js";
import { settleDuplicateSessionSqliteArchives } from "./doctor-session-sqlite-retirement.js";
import {
  createMigrationTargetInput,
  filterLegacySessionStoreTargets,
  prepareDoctorSessionSqliteTargets,
  resolveDoctorSessionSqliteConfig,
  resolveDoctorSessionSqliteMaintenancePaths,
  resolveDoctorSessionSqliteMaintenanceRoots,
  resolveDoctorSessionSqliteTargets,
} from "./doctor-session-sqlite-targets.js";
import {
  createDoctorSessionSqliteTargetReport,
  countBlockingSessionSqliteIssues,
  isRetainedSourceIssue,
  isInformationalMissingSessionIndex,
  type DoctorSessionSqliteMode,
  type DoctorSessionSqliteOptions,
  type DoctorSessionSqliteReport,
  type DoctorSessionSqliteTargetReport,
  type LegacyArchiveTarget,
} from "./doctor-session-sqlite-types.js";
import { validateLegacySessionRecords } from "./doctor-session-sqlite-verification.js";
import {
  assertDoctorSqliteMaintenancePathsNotAliased,
  type DoctorSqliteMaintenanceAuthority,
} from "./doctor-sqlite-maintenance-lock.js";
export type {
  DoctorSessionSqliteOptions,
  DoctorSessionSqliteReport,
} from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

const retainedArchivePlans = new WeakMap<
  DoctorSessionSqliteReport,
  {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    owners: Array<{ owner: LegacyArchiveTarget; receipt: DeferredPluginSessionImport }>;
  }
>();

/** Destructive production callers hold the Gateway/SQLite-maintenance state lock for the full call. */
export async function runDoctorSessionSqlite(
  options: DoctorSessionSqliteOptions,
  authority?: DoctorSqliteMaintenanceAuthority,
): Promise<DoctorSessionSqliteReport> {
  const env = options.env ?? process.env;
  const cfg = resolveDoctorSessionSqliteConfig(options);
  const configuredAgentIds = new Set(listAgentIds(cfg));
  let pendingPlugins = readDeferredPluginMigrations({ env });
  const verifyMissingIndex = createMissingSessionIndexVerifier({ cfg, env });
  const {
    targets: candidates,
    knownTargets,
    repairEntryStates,
  } = await prepareDoctorSessionSqliteTargets({ ...options, cfg, env, authority });
  if (options.mode === "import" || options.mode === "recover") {
    const plugins = normalizePluginsConfig(cfg.plugins);
    const disabled = pendingPlugins
      .filter(({ pluginId }) => {
        const id = normalizePluginId(pluginId);
        return (
          !plugins.enabled || plugins.entries[id]?.enabled === false || plugins.deny.includes(id)
        );
      })
      .map(({ pluginId }) => pluginId);
    if (disabled.length > 0) {
      authority?.assertCurrent();
      pendingPlugins =
        (await recordDeferredPluginMigrations({
          env,
          pending: [],
          resolvedPluginIds: disabled,
          expectedPending: pendingPlugins,
        })) ?? pendingPlugins;
    }
  }
  const settlements =
    options.mode === "import" || options.mode === "recover"
      ? await settleDuplicateSessionSqliteArchives({
          cfg,
          env,
          targets: candidates.map(createMigrationTargetInput),
        })
      : [];
  let historicalSources = ["import", "dry-run", "validate", "recover"].includes(options.mode)
    ? collectHistoricalArchiveSources({ cfg, env })
    : undefined;
  let historicalArchives = historicalSources?.sources ?? new Map();
  const targets = filterLegacySessionStoreTargets(
    candidates,
    options.mode,
    historicalArchives,
    new Set(settlements.map(({ target }) => target.storePath)),
  );
  if (options.mode === "restore") {
    return restoreDoctorSessionSqliteTargets({
      env,
      targets,
    });
  }
  if (options.mode === "recover") {
    return recoverDoctorSessionSqliteTargets({
      env,
      options,
      targets,
      prepareTarget: (target) => repairEntryStates([target]),
      recoveryInventory: historicalSources?.inventory,
      historicalArchiveStores: new Set([
        ...historicalArchives.keys(),
        ...settlements.map(({ target }) => target.storePath),
      ]),
      validateTarget: async (target) => {
        authority?.assertCurrent();
        const report = collectHistoricalArchiveSources({ cfg, env }).sources.get(target.storePath)
          ?.transcripts.length
          ? (
              await runDoctorSessionSqlite(
                {
                  cfg,
                  env,
                  mode: "import",
                  store: target.storePath,
                  agent: target.agentId,
                },
                authority,
              )
            ).targets[0]!
          : await inspectOrMigrateTarget({
              authority,
              configuredAgentIds,
              cfg,
              env,
              mode: "recover",
              target,
              verifyMissingIndex,
              deferredPluginIds: deferredPluginSessionStoreIds({ target, pending: pendingPlugins }),
            });
        report.issues.push(
          ...settlements
            .filter((item) => item.target.storePath === target.storePath)
            .flatMap((item) => item.issues),
        );
        return report;
      },
    });
  }
  if (options.mode === "import") {
    await reconcileSessionSqliteMigrationPublications({
      env,
      trustedTargets: targets.map(createMigrationTargetInput),
    });
    // Reconciliation can consume a restored original and rewrite its receipt.
    historicalSources = collectHistoricalArchiveSources({ cfg, env });
    historicalArchives = historicalSources.sources;
  }
  const activeRun =
    options.mode === "import" && targets.length > 0
      ? createSessionSqliteMigrationRun(env, targets.map(createMigrationTargetInput))
      : undefined;
  const coverage =
    options.mode === "import" || options.mode === "dry-run" || options.mode === "validate"
      ? gatherLegacyArchiveCoverage(cfg, env, targets, knownTargets)
      : undefined;
  const reports: DoctorSessionSqliteTargetReport[] = [];
  const archiveTargets: LegacyArchiveTarget[] = [];
  for (const target of targets) {
    reports.push(
      await inspectOrMigrateTarget({
        authority,
        configuredAgentIds,
        activeRun,
        archiveTargets,
        verifyMissingIndex,
        cfg,
        env,
        mode: options.mode,
        target,
        historicalArchives,
        recoveryInventory: historicalSources?.inventory,
        referencedPaths: coverage?.referencedPaths,
        expectedIndexIdentity: coverage?.indexIdentities.get(
          canonicalMigrationFilePath(target.storePath),
        ),
        deferredPluginIds: deferredPluginSessionStoreIds({
          target,
          pending: pendingPlugins,
        }),
      }),
    );
  }
  for (const report of reports) {
    report.issues.push(
      ...settlements
        .filter((item) => item.target.storePath === report.storePath)
        .flatMap((item) => item.issues),
    );
  }
  if (activeRun && coverage) {
    for (const owner of archiveTargets) {
      if (
        owner.sourceConflicts?.size &&
        (!shouldFilterLegacySessionRecordsByTarget(owner.sourceTarget) ||
          (options.allAgents &&
            !options.agent &&
            !options.store &&
            (coverage.selectedStorePaths.has(owner.target.storePath) ||
              coverage.incompleteDirectories.has(path.dirname(owner.target.storePath))) &&
            coverage.knownTargets
              .filter(
                (known) => canonicalMigrationFilePath(known.storePath) === owner.target.storePath,
              )
              .every((known) =>
                archiveTargets.some(
                  (candidate) =>
                    candidate.target.agentId === known.agentId &&
                    candidate.target.storePath === owner.target.storePath &&
                    candidate.validated,
                ),
              ))) &&
        targets
          .filter(
            (target) => canonicalMigrationFilePath(target.storePath) === owner.target.storePath,
          )
          .every((target) =>
            archiveTargets.some(
              (candidate) => candidate.sourceTarget === target && candidate.validated,
            ),
          )
      ) {
        await archiveConflictingRetainedSessionSources(
          {
            cfg,
            env,
            target: owner.sourceTarget,
            activeRun,
            protectedPaths: coverage.retainedPaths,
            expectedIndexIdentity: coverage.indexIdentities.get(owner.target.storePath),
            targets: archiveTargets
              .filter((candidate) => candidate.target.storePath === owner.target.storePath)
              .map((candidate) => candidate.target),
          },
          owner.sourceConflicts,
          owner.report,
        );
      }
    }
    const deferredSourcePaths = new Set<string>();
    for (const target of reports.filter(isInformationalMissingSessionIndex)) {
      coverage.selectedStorePaths.delete(canonicalMigrationFilePath(target.storePath));
      coverage.retainedDirectories.add(path.dirname(canonicalMigrationFilePath(target.storePath)));
    }
    for (const owner of archiveTargets) {
      for (const source of owner.sourceConflicts?.keys() ?? []) {
        coverage.retainedPaths.add(canonicalMigrationFilePath(source));
        deferredSourcePaths.add(canonicalMigrationFilePath(source));
      }
    }
    const retainDeferredSources = () => {
      for (const owner of archiveTargets) {
        if (owner.deferredPluginIds.length > 0) {
          coverage.selectedStorePaths.delete(canonicalMigrationFilePath(owner.target.storePath));
          coverage.retainedDirectories.add(
            path.dirname(canonicalMigrationFilePath(owner.target.storePath)),
          );
          if (owner.retainedImportVerified) {
            // Retry skips historical discovery; the receipt retains those originals too.
            for (const source of owner.verifiedSources ?? []) {
              deferredSourcePaths.add(canonicalMigrationFilePath(source.path));
            }
          }
        }
      }
    };
    const publishArchive = (remove: () => void, retainSource: () => void) => {
      const conflict = withDeferredPluginMigrationsCurrent<
        readonly DeferredPluginMigration[] | undefined
      >(
        {
          env,
          expectedPending: pendingPlugins,
          onConflict(pending) {
            retainSource();
            if (pending.length > 0) {
              for (const owner of archiveTargets) {
                if (!owner.retainedImportVerified && owner.verifiedSources) {
                  recordDeferredPluginSessionImport({
                    cfg,
                    target: owner.sourceTarget,
                    sqlitePath: owner.target.sqlitePath,
                    env,
                    pluginIds: pending.map((plugin) => plugin.pluginId),
                    sources: owner.verifiedSources,
                    recordCount: owner.report.legacyEntries,
                  });
                }
              }
            }
            return pending;
          },
        },
        () => {
          remove();
          return undefined;
        },
      );
      if (conflict) {
        for (const owner of archiveTargets) {
          owner.deferredPluginIds = deferredPluginSessionStoreIds({
            target: owner.target,
            pending: conflict,
          });
          if (owner.deferredPluginIds.length > 0) {
            owner.retainedImportVerified ||= owner.verifiedSources !== undefined;
            owner.report.issues.push({
              code: "plugin_migration_source_retained",
              message: `Plugin migration obligations changed before archival. Original session migration inputs remain pending for plugin(s): ${owner.deferredPluginIds.join(", ")}. Run openclaw doctor --fix after the plugin is available.`,
            });
          }
        }
        retainDeferredSources();
        throw new DeferredPluginMigrationConflictError(conflict);
      }
    };
    retainDeferredSources();
    await archiveLegacyArtifacts(
      archiveTargets,
      coverage,
      activeRun,
      undefined,
      undefined,
      publishArchive,
    );
    for (const { target, report } of archiveTargets) {
      appendActiveSqliteTranscriptFileIssues(target, report, deferredSourcePaths);
    }
    // Findings belong to every inspected target, including historical-only targets with no moves.
    for (const report of reports) {
      updateMigrationManifestTarget(activeRun, createMigrationTargetInput(report), report.issues);
    }
    await archiveImportedLegacySessionStores(
      archiveTargets,
      activeRun,
      coverage,
      undefined,
      publishArchive,
    );
    for (const owner of archiveTargets) {
      if (owner.retainedImportVerified && owner.deferredPluginIds.length === 0) {
        try {
          retireDeferredPluginSessionImport({
            cfg,
            env,
            target: owner.sourceTarget,
            sqlitePath: owner.target.sqlitePath,
          });
        } catch (error) {
          owner.report.issues.push({
            code: "retained_plugin_source_conflict",
            message: `Deferred import receipt awaits retirement: ${formatErrorMessage(error)}. Run openclaw doctor --fix to retry.`,
          });
          updateMigrationManifestTarget(activeRun, owner.target, owner.report.issues);
        }
      }
    }
    const hasBlockingIssues = reports.some(
      (report) => countBlockingSessionSqliteIssues(report) > 0,
    );
    activeRun.manifest.completedAt = new Date().toISOString();
    if (hasBlockingIssues) {
      activeRun.manifest.failedAt = activeRun.manifest.completedAt;
      writeSessionSqliteMigrationManifest(activeRun);
      const failureReports = writeSessionSqliteMigrationFailureReports(activeRun.manifestPath, {
        reason: "doctor import reported session SQLite migration issues",
      });
      activeRun.manifest.failureReports = failureReports;
    }
    writeSessionSqliteMigrationManifest(activeRun);
  }
  const report = summarizeDoctorSessionSqliteReport(options.mode, reports, activeRun);
  if (activeRun) {
    const owners = archiveTargets
      .filter(
        (owner) =>
          owner.retainedImportVerified &&
          owner.deferredPluginIds.length > 0 &&
          !owner.sourceConflicts?.size,
      )
      .map((owner) => {
        const receipt = readDeferredPluginSessionImport({
          cfg,
          target: owner.sourceTarget,
          sqlitePath: owner.target.sqlitePath,
          env,
        });
        if (!receipt) {
          throw new Error("Verified retained session import receipt is missing.");
        }
        return { owner, receipt };
      });
    if (owners.length > 0) {
      retainedArchivePlans.set(report, { cfg, env: { ...env }, owners });
    }
  }
  return report;
}

/** Verified originals retained for unavailable plugins still await settlement. */
export function hasRetainedDoctorSessionSources(report: DoctorSessionSqliteReport): boolean {
  return retainedArchivePlans.has(report);
}

/** Retire only this import's verified originals before the last plugin obligation clears. */
export async function settleRetainedDoctorSessionSources(
  report: DoctorSessionSqliteReport,
  completedPluginIds: readonly string[],
  authority: DoctorSqliteMaintenanceAuthority,
  assertCompletionCurrent: () => void,
): Promise<void> {
  const plan = retainedArchivePlans.get(report);
  if (!plan) {
    return;
  }
  const assertCurrent = () => {
    authority.assertCurrent();
    assertCompletionCurrent();
  };
  assertCurrent();
  retainedArchivePlans.delete(report);
  const completed = new Set(completedPluginIds);
  const expectedPending = readDeferredPluginMigrations({ env: plan.env });
  const remainingPending = expectedPending.filter((plugin) => !completed.has(plugin.pluginId));
  if (remainingPending.length > 0) {
    return;
  }
  const publishArchive = (remove: () => void, retainSource: () => void) => {
    const conflict = withDeferredPluginMigrationsCurrent<
      readonly DeferredPluginMigration[] | undefined
    >(
      {
        env: plan.env,
        expectedPending,
        onConflict(pending) {
          authority.assertCurrent();
          retainSource();
          return pending;
        },
      },
      () => {
        remove();
        return undefined;
      },
    );
    if (conflict) {
      throw new DeferredPluginMigrationConflictError(conflict);
    }
  };
  const verifyImports = () => {
    assertCurrent();
    for (const { owner, receipt } of plan.owners) {
      const current = readDeferredPluginSessionImport({
        cfg: plan.cfg,
        target: owner.sourceTarget,
        sqlitePath: owner.target.sqlitePath,
        env: plan.env,
      });
      if (!current || !isDeepStrictEqual(current, receipt)) {
        throw new Error("Verified retained session import receipt changed before settlement.");
      }
    }
  };
  const owners = plan.owners.map(({ owner }) => ({
    ...owner,
    deferredPluginIds: [],
    report: {
      ...owner.report,
      archivedLegacyStoreFiles: [...(owner.report.archivedLegacyStoreFiles ?? [])],
      archivedTranscriptFiles: [...owner.report.archivedTranscriptFiles],
      archivedUnreferencedJsonlFiles: [...owner.report.archivedUnreferencedJsonlFiles],
      issues: owner.report.issues.filter(
        (issue) => issue.code !== "plugin_migration_source_retained",
      ),
    },
  }));
  let activeRun: ActiveSessionSqliteMigrationRun | undefined;
  let failure: Error | undefined;
  try {
    verifyImports();
    const coverage = gatherLegacyArchiveCoverage(
      plan.cfg,
      plan.env,
      owners.map(({ sourceTarget }) => sourceTarget),
    );
    verifyImports();
    const targets = owners.map(({ target }) => target);
    assertDoctorSqliteMaintenancePathsNotAliased(
      "retained session source settlement",
      resolveDoctorSessionSqliteMaintenancePaths(targets),
      resolveDoctorSessionSqliteMaintenanceRoots(targets, plan.env),
    );
    assertCurrent();
    activeRun = createSessionSqliteMigrationRun(plan.env, targets);
    for (const owner of owners) {
      updateMigrationManifestTarget(activeRun, owner.target, owner.report.issues, {
        validationBeforeArchive: "passed",
      });
    }
    const capturedSources = new Set(
      plan.owners.flatMap(({ receipt }) => receipt.sources.map((source) => source.path)),
    );
    await archiveLegacyArtifacts(
      owners,
      coverage,
      activeRun,
      assertCurrent,
      capturedSources,
      publishArchive,
    );
    verifyImports();
    await archiveImportedLegacySessionStores(
      owners.filter((owner) => owner.report.issues.every(isRetainedSourceIssue)),
      activeRun,
      coverage,
      assertCurrent,
      publishArchive,
    );
    verifyImports();
    const issue = owners
      .flatMap((owner) => owner.report.issues)
      .find((candidate) => !isRetainedSourceIssue(candidate));
    if (issue || owners.some((owner) => fs.existsSync(owner.target.storePath))) {
      throw new Error(issue?.message ?? "Retained session sources could not be archived.");
    }
    for (const { owner } of plan.owners) {
      retireDeferredPluginSessionImport({
        cfg: plan.cfg,
        env: plan.env,
        target: owner.sourceTarget,
        sqlitePath: owner.target.sqlitePath,
        completedPluginIds,
        assertCurrent,
      });
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(formatErrorMessage(error));
    const failedOwners = owners.filter((owner) =>
      owner.report.issues.some((issue) => !isRetainedSourceIssue(issue)),
    );
    for (const [index, owner] of owners.entries()) {
      owner.report.issues.push(
        ...plan.owners[index]!.owner.report.issues.filter(
          (issue) => issue.code === "plugin_migration_source_retained",
        ),
      );
      if (failedOwners.length === 0 || failedOwners.includes(owner)) {
        const ownIssue = owner.report.issues.find(
          (issue) =>
            !isRetainedSourceIssue(issue) && issue.code !== "plugin_migration_source_retained",
        );
        owner.report.issues.push({
          code: "retained_plugin_source_settlement_failed",
          message: ownIssue?.message ?? formatErrorMessage(error),
        });
      }
    }
  }
  for (const [index, owner] of owners.entries()) {
    Object.assign(plan.owners[index]!.owner.report, owner.report);
  }
  if (activeRun) {
    assertCurrent();
    for (const owner of owners) {
      updateMigrationManifestTarget(activeRun, owner.target, owner.report.issues);
    }
    activeRun.manifest.completedAt = new Date().toISOString();
    if (failure) {
      activeRun.manifest.failedAt = activeRun.manifest.completedAt;
    }
    writeSessionSqliteMigrationManifest(activeRun);
  }
  Object.assign(report, summarizeDoctorSessionSqliteReport(report.mode, report.targets, activeRun));
  if (failure) {
    throw failure;
  }
}

/** Called only under the public maintenance lock, before its strict alias recheck. */
export async function reconcileDoctorSessionSqlitePublication(
  options: DoctorSessionSqliteOptions,
  sourcePath: string,
): Promise<void> {
  const env = options.env ?? process.env;
  const cfg = resolveDoctorSessionSqliteConfig(options);
  const { targets } = resolveDoctorSessionSqliteTargets({ ...options, cfg, env });
  assertDoctorSqliteMaintenancePathsNotAliased(
    `session SQLite ${options.mode}`,
    resolveDoctorSessionSqliteMaintenancePaths(targets),
    resolveDoctorSessionSqliteMaintenanceRoots(targets, env),
  );
  await reconcileSessionSqliteMigrationPublications({
    env,
    sourcePath,
    trustedTargets: targets.map(createMigrationTargetInput),
  });
}

async function inspectOrMigrateTarget(params: {
  authority?: DoctorSqliteMaintenanceAuthority;
  configuredAgentIds: ReadonlySet<string>;
  verifyMissingIndex: ReturnType<typeof createMissingSessionIndexVerifier>;
  historicalArchives?: HistoricalArchiveSources;
  recoveryInventory?: ReturnType<typeof collectRecoveryInventory>;
  referencedPaths?: ReadonlySet<string>;
  activeRun?: ActiveSessionSqliteMigrationRun;
  archiveTargets?: LegacyArchiveTarget[];
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: Exclude<DoctorSessionSqliteMode, "restore">;
  target: SessionStoreTarget;
  expectedIndexIdentity?: MigrationArtifactIdentity;
  deferredPluginIds?: string[];
}): Promise<DoctorSessionSqliteTargetReport> {
  const issues: DoctorSessionSqliteIssue[] = [];
  // Exact SQLite locators are maintenance targets, never legacy import sources.
  // Keeping them out of the file path also prevents archiving a live database.
  const isSqliteStore = params.target.storePath.endsWith(".sqlite");
  const report = createDoctorSessionSqliteTargetReport({
    ...params.target,
    sqlitePath: resolveTargetSqlitePath(params.target, params.env),
    sqliteEntries: readSqliteEntryCount(params.target),
    archivedLegacyStoreFiles: [],
    issues,
  });
  const retained = await prepareRetainedSessionImport(params, report);
  if (!retained) {
    return report;
  }
  const { retainedImport, sourceConflicts, retainedIndexPath } = retained;
  if (params.mode === "recover" && !shouldFilterLegacySessionRecordsByTarget(params.target)) {
    await archiveConflictingRetainedSessionSources(params, sourceConflicts, report);
  }
  const allRecords =
    isSqliteStore || sourceConflicts.has(path.resolve(params.target.storePath))
      ? []
      : readLegacySessionRecords(params.target, issues, {
          allowMissingStore: true,
          ...(retainedIndexPath ? { sourcePath: retainedIndexPath } : {}),
          verifiedSourcePaths: retainedImport
            ? new Set(retainedImport.sources.map((source) => source.path))
            : undefined,
        });
  if (
    !isSqliteStore &&
    (!retainedImport || !retainedIndexPath) &&
    params.mode !== "inspect" &&
    params.mode !== "compact" &&
    (issues.every(({ code }) => code === "retained_plugin_source_index_rebuilt") || retainedImport)
  ) {
    const archiveSources = params.historicalArchives?.get(
      canonicalMigrationFilePath(params.target.storePath),
    );
    const ownershipRecords = readArchivedSessionOwnership(
      params.target,
      retainedImport ? [] : (archiveSources?.stores ?? []),
      issues,
    );
    const snapshot = readOnlySqliteValidationSnapshot(params.target);
    if (snapshot.ok && ownershipRecords) {
      const discovered = await discoverLegacyHistoricalTranscripts({
        target: params.target,
        records: allRecords,
        ownershipRecords,
        referencedPaths: params.referencedPaths,
        archiveSources: !retainedImport ? archiveSources?.transcripts : [],
        verifiedSourcePaths: retainedImport
          ? new Set(
              retainedImport.sources
                .filter((source) => !sourceConflicts.has(source.path))
                .map((source) => source.path),
            )
          : undefined,
        snapshot: snapshot.snapshot,
        issues,
      });
      for (const historical of discovered) {
        const registered = allRecords.find(
          (record) =>
            record.sessionKey === historical.sessionKey &&
            record.entry.sessionId === historical.entry.sessionId &&
            (!record.transcriptPath || !fs.existsSync(record.transcriptPath)),
        );
        if (registered) {
          // Resolve a missing legacy filename here, never in runtime session path resolution.
          registered.transcriptPath = historical.transcriptPath;
          registered.transcriptDependencies.push(...historical.transcriptDependencies);
          registered.historical = historical.historical;
        } else {
          allRecords.push(historical);
        }
      }
    } else if (!snapshot.ok) {
      issues.push({ code: "sqlite_read_failed", message: String(snapshot.error) });
    }
  }
  const records = shouldFilterLegacySessionRecordsByTarget(params.target)
    ? allRecords.filter((record) =>
        isLegacySessionRecordOwnedByTarget(params.cfg, params.target, record.sessionKey),
      )
    : allRecords;
  const referencedTranscriptFiles = new Set(
    allRecords.flatMap((record) => (record.transcriptPath ? [record.transcriptPath] : [])),
  );
  Object.assign(report, {
    legacyEntries: records.length,
    referencedTranscriptFiles: referencedTranscriptFiles.size,
    unreferencedJsonlFiles: isSqliteStore
      ? []
      : listUnreferencedJsonlFiles(params.target.storePath, [...referencedTranscriptFiles]),
  });
  const retainedSourcePaths = retainedImport
    ? new Set(retainedImport.sources.map((source) => canonicalMigrationFilePath(source.path)))
    : undefined;
  if ((params.mode === "import" && retainedImport) || params.mode === "recover") {
    const activeRecords = await prepareActiveSqliteTranscriptSettlement({
      target: params.target,
      env: params.env,
      report,
      excludedPaths: retainedSourcePaths ?? new Set(),
    });
    if (activeRecords.length > 0) {
      const target = createMigrationTargetInput(params.target);
      const activeRun = params.activeRun ?? createSessionSqliteMigrationRun(params.env, [target]);
      const activeCoverage = gatherLegacyArchiveCoverage(params.cfg, params.env, [params.target]);
      if (isSqliteStore) {
        // An explicit database is a maintenance locator, never an index to import or archive.
        activeCoverage.selectedStorePaths.add(target.storePath);
      }
      await archiveLegacyArtifacts(
        [
          {
            sourceTarget: params.target,
            target,
            report,
            validated: true,
            deferredPluginIds: [],
            retainedImportVerified: false,
            records: activeRecords.map(({ entry, ...record }) => ({
              ...record,
              sessionId: entry.sessionId,
            })),
          },
        ],
        activeCoverage,
        activeRun,
        undefined,
        new Set(activeRecords.map((record) => record.transcriptPath!)),
      );
      updateMigrationManifestTarget(activeRun, target, report.issues, {
        validationBeforeArchive: "passed",
      });
      if (!params.activeRun) {
        activeRun.manifest.completedAt = new Date().toISOString();
        writeSessionSqliteMigrationManifest(activeRun);
      }
    }
  }
  if (params.mode === "import" && retainedImport) {
    for (const source of report.unreferencedJsonlFiles) {
      if (!retainedSourcePaths?.has(canonicalMigrationFilePath(source)) && fs.existsSync(source)) {
        report.issues.push({
          code: "plugin_migration_source_retained",
          message: `${source}: skipped because the deferred-plugin-session-import receipt for ${params.target.storePath} still retains inputs for plugin(s): ${retainedImport.pluginIds.join(", ")}. Run openclaw doctor --fix to finish or retire the plugin migration, then rerun openclaw doctor --session-sqlite import. The new transcript remains in place.`,
        });
      }
    }
  }
  if (
    retainedImport &&
    params.mode !== "import" &&
    retainedImport.sources.some((source) => fs.existsSync(source.path))
  ) {
    appendRetainedPluginSessionSourceIssue(report, params.deferredPluginIds ?? []);
  }
  if (params.mode === "compact") {
    await compactSqliteDatabase(params.target, report, { env: params.env });
    report.sqliteEntries = readSqliteEntryCount(params.target);
  }
  if (isSqliteStore || params.mode === "inspect" || params.mode === "compact") {
    appendSqliteDbStats(params.target, report);
    if (params.mode !== "compact") {
      appendActiveSqliteTranscriptFileIssues(params.target, report, retainedSourcePaths);
    }
    return report;
  }
  // A retained but ineligible support artifact does not make an already migrated store work.
  if (
    records.length === 0 &&
    report.unreferencedJsonlFiles.length === 0 &&
    !fs.existsSync(params.target.storePath) &&
    !retainedImport
  ) {
    if (issues.length === 0) {
      report.sqliteEntries = 0;
    }
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      issues,
    );
    return report;
  }
  if (!retainedImport && params.verifyMissingIndex(report)) {
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      report.issues,
      { validationBeforeArchive: "passed" },
    );
    return report;
  }
  if (retainedImport) {
    countRetainedSessionSources(retained, records, report);
  } else if (params.mode === "import") {
    await importLegacySessionRecords(params, records, report, params.activeRun);
  } else if (params.mode === "dry-run") {
    for (const record of records) {
      countLegacyTranscript(record, report);
    }
  } else {
    validateLegacySessionRecords(params.target, records, report, "validate", params.env);
  }
  let validationPassed = retainedImport !== undefined;
  if (params.mode === "import" && retainedImport) {
    // Exact source and database identities carry the earlier verified import into archival.
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      report.issues,
      {
        validationBeforeArchive: "passed",
      },
    );
  }
  if (
    params.mode === "import" &&
    !retainedImport &&
    countBlockingSessionSqliteIssues(report) === 0
  ) {
    validationPassed = validateLegacySessionRecords(
      params.target,
      records,
      report,
      "before-archive",
      params.env,
    );
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      report.issues,
      {
        validationBeforeArchive: validationPassed ? "passed" : "failed",
      },
    );
    if (validationPassed && params.activeRun) {
      const recoveredMoves = records.flatMap((record) =>
        record.historical?.archiveMove && record.recovery?.complete
          ? [
              {
                ...record.historical.archiveMove,
                sessionKey: record.sessionKey,
                artifact: {
                  ...record.historical.archiveMove.artifact!,
                  classification: "protected" as const,
                  reason: HISTORICAL_IMPORT_REASON,
                },
              },
            ]
          : [],
      );
      // Receipt after verified import allows crash retry, but prevents resurrection after later deletion.
      if (recoveredMoves.length > 0) {
        recordPlannedMigrationMoves(
          params.activeRun,
          createMigrationTargetInput(params.target),
          recoveredMoves,
        );
        recordCompletedMigrationMoves(
          params.activeRun,
          createMigrationTargetInput(params.target),
          recoveredMoves,
        );
      }
    }
    if (validationPassed) {
      // Finalization enables incremental vacuum where needed and releases free pages.
      await compactSqliteDatabase(params.target, report, {
        env: params.env,
        operation: "import-finalize",
      });
    }
  }
  if (params.mode === "import") {
    const indexIdentity = params.expectedIndexIdentity;
    const indexless = !indexIdentity && !fs.existsSync(params.target.storePath);
    const deferredPluginIds =
      indexless && (!params.configuredAgentIds.has(params.target.agentId) || records.length === 0)
        ? []
        : (params.deferredPluginIds ?? []);
    // Zero-row validation may certify an existing canonical store, but must never
    // create a database solely for an unused shared-index owner.
    const verifiedImport =
      validationPassed &&
      (retainedImport !== undefined ||
        records.length > 0 ||
        fs.existsSync(resolveTargetSqlitePath(params.target, params.env)));
    let retainedImportVerified = retainedImport !== undefined;
    let verifiedSources = retainedImport?.sources;
    if (
      !retainedImport &&
      verifiedImport &&
      (indexIdentity ||
        records.some((record) => !record.historical?.archiveMove) ||
        report.unreferencedJsonlFiles.length > 0) &&
      report.issues.every(isRetainedSourceIssue)
    ) {
      try {
        verifiedSources = captureDeferredPluginSessionSources({
          storePath: params.target.storePath,
          indexIdentity,
          records,
          unreferencedJsonlFiles: report.unreferencedJsonlFiles,
          referencedPaths: params.referencedPaths,
        });
      } catch (error) {
        report.issues.push({
          code: "transcript_archive_failed",
          message: formatErrorMessage(error),
        });
      }
    }
    if (
      deferredPluginIds.length > 0 &&
      verifiedImport &&
      report.issues.every(isRetainedSourceIssue)
    ) {
      if (!retainedImport) {
        if (!verifiedSources) {
          report.sqliteEntries = readSqliteEntryCount(params.target);
          return report;
        }
        recordDeferredPluginSessionImport({
          cfg: params.cfg,
          target: params.target,
          sqlitePath: resolveTargetSqlitePath(params.target, params.env),
          env: params.env,
          pluginIds: deferredPluginIds,
          sources: verifiedSources,
          recordCount: records.length,
        });
        retainedImportVerified = true;
        if (indexless) {
          report.issues.push({
            code: "retained_plugin_source_index_rebuilt",
            message: `Derived the retained source index from verified transcripts for ${path.dirname(params.target.storePath)}. Recorded their identities in the completed import receipt without creating sessions.json or replaying canonical metadata.`,
          });
        }
      }
      appendRetainedPluginSessionSourceIssue(report, deferredPluginIds);
    }
    // Retain importer outcomes, not entry or transcript payloads, until every owner finishes.
    params.archiveTargets?.push({
      sourceTarget: params.target,
      target: createMigrationTargetInput(params.target),
      report,
      validated: validationPassed,
      deferredPluginIds,
      retainedImportVerified,
      sourceConflicts,
      verifiedSources,
      records: records
        .filter(
          (record) =>
            !record.historical?.archiveMove && !sourceConflicts.has(record.transcriptPath ?? ""),
        )
        .map(({ entry, ...record }) => Object.assign(record, { sessionId: entry.sessionId })),
    });
  }
  report.sqliteEntries = readSqliteEntryCount(params.target);
  if (params.mode !== "import") {
    appendActiveSqliteTranscriptFileIssues(params.target, report, retainedSourcePaths);
  }
  updateMigrationManifestTarget(
    params.activeRun,
    createMigrationTargetInput(params.target),
    report.issues,
  );
  return report;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
