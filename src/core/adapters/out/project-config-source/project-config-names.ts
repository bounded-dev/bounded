/**
 * The names a project's configuration may have, in the order bounded looks
 * for them: the configuration loader and `bounded init` read this one list,
 * and the prereqs status band's own copy is held equal to it by a test
 * (ADR 2026-027).
 */
export const PROJECT_CONFIG_NAMES = ["bounded.config.ts", "bounded.config.js", "bounded.config.mjs"] as const;
