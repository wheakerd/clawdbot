import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveRealpathOrAbsolute } from "../../infra/boundary-path.js";
import { isPathStrictlyInside } from "../../infra/path-guards.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import type { RetainedHistoryReferences } from "./types.js";

/** Callers select the authoritative owners before combining their admitted protection facts. */
export function mergeRetainedHistoryReferences(
  values: readonly (RetainedHistoryReferences | undefined)[],
): RetainedHistoryReferences | undefined {
  if (values.every((value) => value === undefined)) {
    return undefined;
  }
  return {
    sessionIds: [...new Set(values.flatMap((value) => value?.sessionIds ?? []))],
    artifactPaths: [...new Set(values.flatMap((value) => value?.artifactPaths ?? []))],
  };
}

/** A metadata move cannot release source files that the destination's sweeper cannot protect. */
export function assertRetainedHistoryArtifactTransfer(
  references: RetainedHistoryReferences | undefined,
  sourceArtifactDirectory: string,
  destinationArtifactDirectory: string,
): void {
  if (!references?.artifactPaths.length) {
    return;
  }
  const source = resolveRealpathOrAbsolute(sourceArtifactDirectory);
  const destination = resolveRealpathOrAbsolute(destinationArtifactDirectory);
  if (source === destination) {
    return;
  }
  for (const artifact of references.artifactPaths) {
    const resolvedArtifact = resolveRealpathOrAbsolute(artifact);
    if (!isPathStrictlyInside(source, resolvedArtifact)) {
      continue;
    }
    let exists: boolean;
    try {
      exists = fs.statSync(resolvedArtifact, { throwIfNoEntry: false })?.isFile() === true;
    } catch (error) {
      throw new SessionStoreMigrationRequiredError(
        `Cannot verify protected history artifact ${artifact} before moving from ${source} to ${destination}: ${String(error)}. Preserve both stores and resolve artifact access before retrying Doctor.`,
      );
    }
    if (exists) {
      throw new SessionStoreMigrationRequiredError(
        `Protected history artifact ${artifact} would lose its owner when moving from ${source} to ${destination}. Keep the source agent/store configured and preserve its files; reconcile the protected artifacts before moving this session.`,
      );
    }
  }
}

/** Validate protection facts without interpreting legacy checkpoint metadata. */
export function assertCanonicalRetainedHistoryReferences(
  value: unknown,
): asserts value is RetainedHistoryReferences | undefined {
  if (value === undefined) {
    return;
  }
  const refuse = (): never => {
    throw new SessionStoreMigrationRequiredError(
      "Invalid retained history references; preserve the session store and run openclaw doctor --fix.",
    );
  };
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "sessionIds" && key !== "artifactPaths")
  ) {
    return refuse();
  }
  for (const field of ["sessionIds", "artifactPaths"] as const) {
    const references = value[field];
    if (
      !Array.isArray(references) ||
      references.some(
        (reference: unknown) =>
          typeof reference !== "string" ||
          reference.length === 0 ||
          reference !== reference.trim() ||
          reference.includes("\0") ||
          (field === "artifactPaths" && !path.isAbsolute(reference)),
      ) ||
      new Set(references).size !== references.length
    ) {
      refuse();
    }
  }
}
