import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import type { ConfigValidationIssue } from "../../config/types.openclaw.js";

const MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE = 3;

export function summarizeConfigValidationIssues(
  issues: ReadonlyArray<ConfigValidationIssue>,
): string {
  const trimmed = issues.slice(0, MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE);
  const lines = normalizeStringEntries(
    formatConfigIssueLines(trimmed, "", { normalizeRoot: true }),
  );
  if (lines.length === 0) {
    return "invalid config";
  }
  const hiddenCount = Math.max(0, issues.length - lines.length);
  return `invalid config: ${lines.join("; ")}${
    hiddenCount > 0 ? ` (+${hiddenCount} more issue${hiddenCount === 1 ? "" : "s"})` : ""
  }`;
}
