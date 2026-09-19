import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { sessionToolOverridesEqual } from "../session-tool-overrides.js";

export function resolveSessionPatchExpectationError(
  patch: SessionsPatchParams,
): string | undefined {
  if (patch.expectedSandboxMode !== undefined && patch.sandboxMode === undefined) {
    return "expectedSandboxMode requires a sandboxMode replacement.";
  }
  if (patch.expectedPermissionMode !== undefined && patch.permissionMode === undefined) {
    return "expectedPermissionMode requires a permissionMode replacement.";
  }
  if (
    patch.expectedNativeRuntimeConsent !== undefined &&
    patch.nativeRuntimeConsent === undefined
  ) {
    return "expectedNativeRuntimeConsent requires a nativeRuntimeConsent replacement.";
  }
  if (
    typeof patch.nativeRuntimeConsent === "string" &&
    (!patch.expectedSessionId ||
      patch.expectedPermissionMode === undefined ||
      patch.expectedSandboxMode === undefined ||
      patch.expectedNativeRuntimeConsent === undefined ||
      patch.permissionMode !== "full" ||
      patch.sandboxMode !== "off")
  ) {
    return "Native runtime consent requires the current session and execution settings, Full access, and sandbox off.";
  }
  if (patch.expectedToolOverrides !== undefined && patch.toolOverrides === undefined) {
    return "expectedToolOverrides requires a toolOverrides replacement.";
  }
  return undefined;
}

export function sessionPatchExpectationsChanged(
  entry: SessionEntry | undefined,
  patch: SessionsPatchParams,
): boolean {
  return (
    (patch.expectedSandboxMode !== undefined &&
      (entry?.sandboxMode ?? null) !== patch.expectedSandboxMode) ||
    (patch.expectedPermissionMode !== undefined &&
      (entry?.permissionMode ?? null) !== patch.expectedPermissionMode) ||
    (patch.expectedNativeRuntimeConsent !== undefined &&
      (entry?.nativeRuntimeConsent ?? null) !== patch.expectedNativeRuntimeConsent) ||
    (patch.expectedToolOverrides !== undefined &&
      !sessionToolOverridesEqual(entry?.toolOverrides, patch.expectedToolOverrides))
  );
}

export function sessionPatchTargetIdentity(patch: SessionsPatchParams) {
  return {
    key: patch.key,
    ...(patch.agentId ? { agentId: patch.agentId } : {}),
    ...(patch.expectedSessionId !== undefined
      ? { expectedSessionId: patch.expectedSessionId }
      : {}),
    ...(patch.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: patch.expectedLifecycleRevision }
      : {}),
    ...(patch.expectedPermissionMode !== undefined
      ? { expectedPermissionMode: patch.expectedPermissionMode }
      : {}),
    ...(patch.expectedSandboxMode !== undefined
      ? { expectedSandboxMode: patch.expectedSandboxMode }
      : {}),
    ...(patch.expectedNativeRuntimeConsent !== undefined
      ? { expectedNativeRuntimeConsent: patch.expectedNativeRuntimeConsent }
      : {}),
    ...(patch.expectedToolOverrides !== undefined
      ? { expectedToolOverrides: patch.expectedToolOverrides }
      : {}),
    expectedMarkedUnreadAt: patch.expectedMarkedUnreadAt,
  };
}
