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
  2026-006). A rule denying `modify` must also deny `create` or `delete`, or
  a delete and a create would change the file. There are no allow rules:
  any rule that denies refuses. A rule's `except` carves paths out of that
  rule only, and may not cover the whole match (identical, or `**`).
- **Patterns are checked, never hand-matched.** picomatch compiles every
  glob (strict brackets, no extglobs). The check refuses empty, absolute,
  negated (`!`, use `except`), `..`-using and backslashed patterns,
  parentheses (extglobs and regex groups; braces cover real needs), a `/` or
  `**` inside a group (so a pattern splits into its path parts at every
  `/`), a trailing `/`, and patterns over 512 characters. It tidies `./`,
  `//` and Unicode form. A redirect and a why hold no control characters and
  at most 1000 characters.
- **Matching.** Matching sees dotfiles; `match` ignores case (so a rule
  cannot be dodged on case-insensitive file systems), `except` does not (so a
  carve-out never grows). A match ending in a literal name also covers
  everything under that name, as in .gitignore: `packages/db` protects
  `packages/db/x.ts`. A match ending in a glob covers only what it matches.
- **Per effect.** `read`, `create` and `modify` are judged by the exact path.
  `list` is judged conservatively: refused when the root, or anything below
  it, could be a path the rule applies to, walking the rule's parts along the
  root's (a part holding `**` spans any number of parts). An `except` helps
  only when it ends in `**` and covers the whole root. A filter helps only
  when it provably cannot name a path the rule ends in: a literal filter the
  rule's last part does not match, or two pure literal suffixes (`*.pem`,
  `*.ts`) or prefixes (`key*`, `id*`) neither of which extends the other. A
  filter with `/` or `**` proves nothing, and two other globs may share a name
  (`.env*` and `*.tsx` both match `.env.tsx`). A rule ending in a literal name
  covers that name's contents, so no filter rules it out. A read over a root
  the same call lists (compared ignoring case) is a content search, judged as
  reaching everything the listing could. A `delete` is also refused when the
  path could hold a path the rule denies delete for, walking the rule only up
  to its first spanning part, since the guard cannot know whether the path is
  a directory: `packages/db/**` refuses deleting `packages`, and deleting `.`
  is always refused, but `**`-led rules do not refuse every delete. Execute,
  fetch, delegate and invoke are not judged by path: a shell command's paths
  cannot be read from its text (the later hash-check slice covers them).
- **Provenance and redirects.** A refusal names the path (via dispatch's
  prefix), the rule's `match`, the pack that contributed the rule (from the
  composition's entries) and the rule's `why`. The redirect is the rule's;
  a listing or search refusal composes its own: "List (or Search) a root
  outside '<match>', or give a filter that cannot match it — <rule's
  redirect>". When several rules deny, the first in pack order is named.
- **Its own guardrails.** The path gate gives its own point two rules:
  every write to `**/bounded.config.*` (any depth, any extension a loader
  might pick up) and to `.bounded/**` is refused. They are ordinary rules,
  listed with the rest and named in refusals. Adapters write the guard log
  in `.bounded/` directly, not through guards.

## Why

A gate in the core would give the core an opinion; as a pack it is selected
like any other and proves the extension mechanism. Deny-only with
rule-owned exceptions means no pack can weaken another's protection.

## Consequences

- A rule is a frozen plain object, not a class with a private constructor:
  contributions are written as object literals of the point's type.
- `**`-led rules make listings and searches across the project refused
  unless the root is outside their reach or a filter provably excludes them.
  Rule authors should prefer literal last parts or pure suffixes
  (`**/.env`, `**/.env.local`, `**/*.pem`) to open globs such as `**/.env*`.
- **Known gap: the configuration's imports.** Only the configuration's entry
  file is protected. What it imports (project pack modules, `package.json`,
  the lockfile, `node_modules/bounded`) can still be changed by an agent and
  so change the guardrails. The loader slice closes this: it computes the
  configuration's import closure and protects it, or requires project packs
  to live under `.bounded/`.
- **Adapters describe directory deletes file by file.** It is an adapter
  obligation (ADR 2026-006) that deleting or renaming a directory reaches the
  gate as one write effect per file it contains, plus one for the directory
  itself; `contains()` stays as a backstop for an adapter that sends only the
  directory. Without that, deleting `apps` is not refused for a file only
  `**/.env` protects. Shell deletes are covered by the hash-check slice.
- **Wildcards per part.** More than three `*` or `?` in one part of a pattern
  are refused: picomatch backtracks polynomially on a long name
  (`**/*a*a*a*a*b` took seconds on 255 characters), and a guard must stay fast.
- **Honest redirects.** A `**`-led rule ending in a literal name reaches
  every listing and search (its name may be a directory of any file), so its
  refusals say no listing or search can avoid it, and to name or read the
  files directly or ask a person, instead of suggesting another root.
- **Planned: `exclude` on the list effect** (a core change, its own ADR). A
  host whose search skips paths (for example ignored or hidden files) could
  say so on the list effect, and the path gate could then allow a listing
  whose excludes provably cover a rule. Not built.
- Role path rules (spec Part 3) are a later slice.
