// Files Claude Code itself writes into a project for this machine and user,
// such as the permission rules a "don't ask again" answer records. They are
// not the installation's and not the product's: a re-plan before the first
// ticket keeps them and puts them back (ADR 2026-065). Builtins only.

export const HOST_LOCAL_FILES: readonly string[] = [".claude/settings.local.json"];
