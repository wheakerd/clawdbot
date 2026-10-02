// Accept the current label plus shipped delimiter envelopes during upgrade QA.
const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const RUNTIME_CONTEXT_HEADER = "OpenClaw runtime context:";

export function isInternalRuntimeContextCarrierText(text: string) {
  const trimmed = text.trim();
  // Subagent tasks sit between two closed scaffolding blocks. Only the current
  // label or one complete legacy carrier is transparent to the user turn.
  return (
    trimmed.startsWith(`${RUNTIME_CONTEXT_HEADER}\n`) ||
    (trimmed.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN) &&
      trimmed.indexOf(INTERNAL_RUNTIME_CONTEXT_END) ===
        trimmed.length - INTERNAL_RUNTIME_CONTEXT_END.length)
  );
}
