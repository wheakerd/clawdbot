import type { DeclaredProviderOwnerIndex } from "../provider-owner-index.js";

export type PluginRuntimeLoadContextState = {
  controlPlaneFingerprint: string;
  registrationConfigKey: string;
  declaredProviderOwners: DeclaredProviderOwnerIndex;
};

// Source and built readers share the existing registry-owned context slot.
const pluginRuntimeLoadContext = Symbol.for("openclaw.pluginRuntimeLoadContext");
type ContextCarrier = { [pluginRuntimeLoadContext]?: PluginRuntimeLoadContextState };

export function bindPluginRuntimeLoadContextState(
  registry: object,
  context: PluginRuntimeLoadContextState,
): void {
  Object.defineProperty(registry, pluginRuntimeLoadContext, {
    value: context,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

export function getPluginRuntimeLoadContextState(
  registry: object | undefined,
): PluginRuntimeLoadContextState | undefined {
  // SAFETY: Only the owning setter writes this private registry slot.
  return (registry as ContextCarrier | undefined)?.[pluginRuntimeLoadContext];
}
