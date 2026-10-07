# 2026-009: The path gate is an ordinary pack shipped in `bounded`

**Status:** accepted.

## Decision

- **Where it lives.** The path gate, `bounded/path-gate`, ships in the npm
  package `bounded` (so `packIdsFor("bounded")`), in its own directory
  `contexts/core/src/packs/path-gate/`, exported as `bounded/path-gate`. It is
  an ordinary pack: it depends on `corePack` and uses only `bounded/domain`,
  its own files and the libraries the package declares (picomatch). Nothing
  outside its directory imports it except tests under the context's
  composition root (`src/pack/`), so the core never depends on it.
  `architecture.test.ts` enforces this for every directory under `src/packs/`
  (the "shipped pack" rule; `packs/` holds shipped packs, `pack/` is the
  composition root), and takes an export path's layer from the file it
  points at.
- **Rules are deny-only.** The point `protectedPaths` takes
  `{ match, except?, deny, redirect, why? }`. `deny` is a non-empty list of
  `read`, `list`, `create`, `modify`, `delete`; `writes` is a convenience for
  the last three, spread into the list, so a stored rule is always explicit
  (the spec's coarse "read, write or both" became precise effect kinds, ADR
  2026-006). There are no allow rules: any rule that denies refuses. A rule's
  `except` carves paths out of that rule only.
- **Patterns are checked, never hand-matched.** picomatch compiles every
  glob (strict brackets); the check refuses empty, absolute, negated (`!`,
  use `except`), `..`-using and backslashed patterns, and a `/` inside a group
  (so a pattern can be split into its path parts). It tidies `./`, `//` and
  Unicode form. Matching sees dotfiles; `match` ignores case (so a rule
  cannot be dodged on case-insensitive file systems), `except` does not (so a
  carve-out never grows).
- **Per effect.** `read` and `write` are judged by the exact path (a write by
  its change kind). `list` is judged conservatively: refused when the root
  matches a rule denying `list`, or the rule's parts could reach below the
  root, unless an `except` ending in `**` covers the whole root or the rule
  ends in a literal name the filter does not match. Two globs can share a
  name (`.env*` and `*.tsx` both match `.env.tsx`), so a filter never rules
  out a glob. A read over a root the same call lists is a content search and
  is judged as reaching everything the listing could. Execute, fetch,
  delegate and invoke are not judged by path: a shell command's paths cannot
  be read from its text (the later hash-check slice covers them).
- **Provenance.** A refusal names the path (via dispatch's prefix), the
  rule's `match`, the pack that contributed the rule (from the composition's
  entries) and the rule's `why`; the redirect is the rule's. When several
  rules deny, the first in pack order is named.
- **Its own guardrails.** The path gate gives its own point two rules:
  every write to `bounded.config.*` and `.bounded/**` is refused. They are
  ordinary rules, listed with the rest and named in refusals. Adapters write
  the guard log in `.bounded/` directly, not through guards.

## Why

A gate in the core would give the core an opinion; as a pack it is selected
like any other and proves the extension mechanism. Deny-only with
rule-owned exceptions means no pack can weaken another's protection.

## Consequences

- A rule is a frozen plain object, not a class with a private constructor:
  contributions are written as object literals of the point's type.
- `**`-led rules denying `read` make content searches across the project
  refused unless the root is outside their reach; the redirect is the rule's.
- Role path rules (spec Part 3) and a decision log are later slices.
