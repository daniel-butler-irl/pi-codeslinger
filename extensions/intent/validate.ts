/**
 * Intent validation — pure functions for checking intent readiness.
 *
 * Used as a hard gate when exiting intent mode: the extension code
 * (not the LLM) decides whether the intent is well-defined enough
 * to proceed with execution.
 */

export interface ValidationResult {
  valid: boolean;
  missing: string[];
}

const REQUIRED_SECTIONS = ["Description", "Success Criteria", "Verification"];

/**
 * Check whether a markdown heading has non-empty content beneath it.
 * Strips HTML comments and whitespace — placeholder-only sections fail.
 */
function hasNonEmptySection(content: string, heading: string): boolean {
  const pattern = new RegExp(
    `^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`,
    "m",
  );
  const match = content.match(pattern);
  if (!match) return false;
  const body = match[1].replace(/<!--[\s\S]*?-->/g, "").trim();
  return body.length > 0;
}

/**
 * Validate that an intent's markdown content has all required sections
 * filled in with real content. Returns which sections are missing.
 */
export function validateIntentForLock(content: string): ValidationResult {
  const missing = REQUIRED_SECTIONS.filter(
    (s) => !hasNonEmptySection(content, s),
  );
  return { valid: missing.length === 0, missing };
}
