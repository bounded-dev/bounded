// The bounds of the architect's `sleep` (ADR 2026-029: one definition, two
// hosts). In pi it is a named tool; on Claude Code it is `sleep <n>` through
// the role-narrowed Bash, and the policy there must refuse exactly what the
// tool would clamp. A second copy of the numbers is how the two would drift.

export const SLEEP_MIN_SECONDS = 1;
export const SLEEP_MAX_SECONDS = 120;

/** Clamp to [1, 120]; a non-finite request becomes the minimum. */
export function clampSleepSeconds(requested: number): number {
  if (!Number.isFinite(requested)) return SLEEP_MIN_SECONDS;
  return Math.min(SLEEP_MAX_SECONDS, Math.max(SLEEP_MIN_SECONDS, Math.round(requested)));
}

/** A whole number of seconds inside the bounds, as the bash policy reads it. */
export function isSleepSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= SLEEP_MIN_SECONDS && value <= SLEEP_MAX_SECONDS;
}
