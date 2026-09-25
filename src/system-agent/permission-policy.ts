/**
 * Config that decides what agents may do on their own: tool and exec policy,
 * sandboxing, approvals, and who counts as an owner. A delegated change here
 * always waits for a human decision, even in Full Access, so a run cannot widen
 * its own authority without the owner seeing the exact change.
 */
import { parseConfigSetPath } from "../cli/config-cli-path.js";
import type { SystemAgentOperation } from "./operation-types.js";

const TOOL_POLICY_KEYS = [
  "profile",
  "allow",
  "alsoAllow",
  "deny",
  "byProvider",
  "toolsBySender",
  "elevated",
  "exec",
  "fs",
  "sandbox",
] as const;

const ANY = "*";

const PERMISSION_POLICY_PATHS: readonly (readonly string[])[] = [
  ["approvals"],
  ["security"],
  ["commands", "ownerAllowFrom"],
  ["commands", "allowFrom"],
  ...TOOL_POLICY_KEYS.map((key) => ["tools", key]),
  ["agents", "defaults", "sandbox"],
  ...TOOL_POLICY_KEYS.map((key) => ["agents", "defaults", "tools", key]),
  ["agents", "entries", ANY, "sandbox"],
  ...TOOL_POLICY_KEYS.map((key) => ["agents", "entries", ANY, "tools", key]),
  ["channels", ANY, "execApprovals"],
  ["channels", ANY, "accounts", ANY, "execApprovals"],
  ["skills", "workshop", "approvalPolicy"],
];

// Either path may be the shorter one: replacing `tools` rewrites `tools.exec`,
// and `tools.exec.security` sits inside it.
function overlaps(path: readonly string[], policy: readonly string[]): boolean {
  const shared = Math.min(path.length, policy.length);
  for (let index = 0; index < shared; index += 1) {
    if (policy[index] !== ANY && policy[index] !== path[index]) {
      return false;
    }
  }
  return true;
}

/** True when a config path is, contains, or sits inside agent permission policy. */
export function isPermissionPolicyConfigPath(path: string): boolean {
  let segments: string[];
  try {
    segments = path === "." ? [] : parseConfigSetPath(path);
  } catch {
    return true;
  }
  return PERMISSION_POLICY_PATHS.some((policy) => overlaps(segments, policy));
}

/** True when applying this operation could change what agents are permitted to do. */
export function changesPermissionPolicy(operation: SystemAgentOperation): boolean {
  return (
    (operation.kind === "config-set" || operation.kind === "config-set-ref") &&
    isPermissionPolicyConfigPath(operation.path)
  );
}
