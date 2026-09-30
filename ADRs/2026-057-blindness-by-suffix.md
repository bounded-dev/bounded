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

## Why

The worked example keeps `*.test.ts` beside the code, and a directory split
(`src/` vs `tests/`) cannot express that. Blindness only protects the other
role's authored work, so a name is enough to decide it.

## Consequences

Supersedes TN-26-001's directory zones. Red and green bind to a hash of the
test-side files across all roots instead of the `tests/` tree.
