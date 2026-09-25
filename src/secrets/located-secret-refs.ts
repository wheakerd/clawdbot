/** Finds SecretRefs, with their paths, inside config and auth-profile stores. */
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import { isRecord } from "../utils.js";

type LocatedSecretRef = {
  path: Array<string | number>;
  ref: SecretRef;
};

type SecretDefaults = Parameters<typeof coerceSecretRef>[1];

export function listLocatedSecretRefs(
  value: unknown,
  defaults: SecretDefaults | undefined,
  path: Array<string | number> = [],
  refs: LocatedSecretRef[] = [],
): LocatedSecretRef[] {
  const ref = coerceSecretRef(value, defaults);
  if (ref) {
    refs.push({ path, ref });
    return refs;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      listLocatedSecretRefs(entry, defaults, [...path, index], refs);
    }
    return refs;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value).toSorted()) {
      listLocatedSecretRefs(value[key], defaults, [...path, key], refs);
    }
  }
  return refs;
}

/**
 * Whether config `path` is the only config or auth-profile reference to team
 * store entry `name`. `authStores` comes from the active secrets runtime
 * snapshot; without one, auth-profile references are unknown and the answer
 * is false.
 */
export function isOnlySecretStoreReference(params: {
  sourceConfig: OpenClawConfig;
  authStores: readonly { store: unknown }[] | undefined;
  path: readonly string[];
  name: string;
}): boolean {
  if (!params.authStores) {
    return false;
  }
  const defaults = params.sourceConfig.secrets?.defaults;
  const matches = ({ ref }: LocatedSecretRef) => ref.source === "store" && ref.id === params.name;
  if (params.authStores.some(({ store }) => listLocatedSecretRefs(store, defaults).some(matches))) {
    return false;
  }
  const configRefs = listLocatedSecretRefs(params.sourceConfig, defaults).filter(matches);
  return (
    configRefs.length === 1 && isDeepStrictEqual(configRefs[0]?.path.map(String), [...params.path])
  );
}
