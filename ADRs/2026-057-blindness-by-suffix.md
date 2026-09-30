# 2026-057: Blindness is by file-name suffix, not directory

**Status:** accepted

## Decision

Tests sit next to the code they test. A data field, `testFileSuffixes`,
lists suffixes that make a file test-side (the TypeScript family:
`.test.ts`, `.test.tsx`, `.test-support.ts`). A suffix needs at least two
dotted parts and may not overlap a contract suffix
(`testFileSuffixesFor` in `agent/src/pack-contrib.ts`).

- A file inside a source root is test-side when its name ends with a
  composed test suffix. Generated files (ADR 2026-058) are neither side.
- The builder may list and find test file names. Reading one, searching its
  content, or writing it is refused.
- A content search over a directory is allowed only when its file glob
  provably excludes the other side: a single `!*<suffix>` exclusion, or a
  positive glob with no `{[?!` whose literal tail is disjoint from every
  test suffix. The refusal names a legal glob.
- The test-writer mirrors this on implementation files. Contracts and
  generated files stay readable to both.
- Matching ignores case. An unreadable composition treats every file under a
  root as the other side.
- A `!*<S>` exclusion is legal only when every test suffix ends with S. So
  `!*.test.ts` alone is refused for the TypeScript set (`.test.ts`,
  `.test.tsx`, `.test-support.ts`): no single exclusion covers all three,
  and the builder passes an inclusion glob such as `*.handler.ts` instead.

Added in implementation, to leave no doubt:

- A directory grep needs the host's complete listing of the tree below it,
  and that listing must contain no symlink.
- No role may create a test file whose suffix is in another case
  (`x.Test.ts`).
- A `!*<S>` exclusion is checked against the real file names below the
  directory: a test name in another case refuses it.

Added after adversarial review:

- Non-ASCII names are refused. APFS folds `ſ` (U+017F) onto `s`, so
  `a.teſt.ts` is `a.test.ts`. Any write, and any path a blind role names,
  with a non-ASCII character is refused, as is a non-ASCII glob or a
  directory grep over a tree holding such a name. Existing paths are also
  judged by their canonical spelling (`realpathSync.native`), both in link
  resolution and in the tree walk.
- A grep glob with whitespace or a comma is refused on every host, because
  Claude Code's Grep splits on both. pi hands its glob to rg as one value.
- Before judging, the gate applies the host's own path rewriting. For pi,
  that is `normalizePath`: unicode spaces become ' ', one leading '@' is
  stripped, `~` is expanded, and `file://` is decoded. A pi read that would
  fall back to another spelling is refused. On Claude Code a leading `~`,
  `file:` or `@` is refused. One that survives the rewriting is refused
  everywhere (`agent/src/host-paths.ts`).

## Why

The worked example keeps `*.test.ts` beside the code, and a directory split
(`src/` vs `tests/`) cannot express that. Blindness only protects the other
role's authored work, so a name is enough to decide it.

## Consequences

Supersedes TN-26-001's directory zones. Red and green bind to a hash of the
test-side files across all roots instead of the `tests/` tree.
