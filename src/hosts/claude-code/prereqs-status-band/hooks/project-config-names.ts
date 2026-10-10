/**
 * The names a project's bounded configuration may have, in the order bounded
 * looks for them. The band's own copy (it imports nothing outside its folder),
 * held equal to bounded's PROJECT_CONFIG_NAMES by a test.
 */
export const PROJECT_CONFIG_NAMES = ["bounded.config.ts", "bounded.config.js", "bounded.config.mjs"] as const;
