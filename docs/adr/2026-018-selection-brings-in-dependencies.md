# 2026-018: A selection brings in every pack its packs depend on

**Status:** accepted (the maintainer's decision, and the answers in the
review of the selected-pack-dependencies plan), shipped in the unreleased
`bounded` 3.1.0 as a second deliberate breaking change in a minor release
(see "Release"). Amends ADR 2026-004 (the selection includes dependencies),
ADR 2026-010 (the project depends on the listed packs) and ADR 2026-013
(`Config.listedPacks`, `listedPackIds`, composition's combination rules).

## Context

A project selects packs in `bounded.config.ts`
(`defineConfig({ packs: [...] })`). Until now every pack a selected pack
depends on, directly or transitively, had to be listed as well, or
composition refused the whole configuration ("Pack 'X' depends on pack 'Y',
which is not selected") and every event was refused. The maintainer does not
want users to list dependencies, or dependencies of dependencies,
deliberately. `dependsOn` holds pack objects, so the closure is known
without any lookup.

## Decision

- **The selection is the listed packs and every pack they depend on,
  transitively, through `dependsOn`.** The listed packs are the pack objects
  a caller names (`defineConfig({ packs })`, the second argument of
  `Composition.compose`, the ids sent to compose-packs); a pack selected but
  not listed is *brought in*. A pack that is neither listed nor depended on
  by a selected pack is not selected and leaves no trace.
- **The closure is taken in `SelectedPacks.parse`** (domain), the class that
  already owns "the packs a configuration selects", so both entry points
  (`defineConfig` and the compose-packs feature) get the same rule from one
  place. `SelectedPacks.packs` is every selected pack, in id order;
  `SelectedPacks.listedPacks` (new) is the listed ones. The walk follows
  `dependsOn` only for a pack with no `problem`: a malformed pack is kept in
  the selection unwalked, and composition refuses it as before ("Pack '…' is
  malformed: …"), so a bad dependency fails closed.
- **Every selected pack must be available, by identity** (ADR 2026-004:
  packs are matched by identity, never by id). On the catalog path a
  dependency the catalog does not offer is refused ("Pack 'D' depends on
  pack 'Y', which is not available. Add 'Y' to the available packs, or
  remove the dependency"); a dependency whose id the catalog offers as
  another object keeps its "not the available one" refusal. `Config.compose`
  passes the selection itself as the available packs: in a configuration,
  every pack object present is available.
- **Two different pack objects with one id in the selection are refused**,
  naming where each comes from ("Two different packs have the id 'X': one
  listed, and one that 'D' depends on. They are two copies of one package,
  or two packs given one id; make every pack use the same one"). Ids name
  one pack in messages and logs, and picking one copy would be a guess.
- **Messages about what the caller wrote say "listed"**: "Pack 'X' is listed
  but not available. Make it available, or remove it from the list", "Pack
  'X' is listed twice. List each pack once". "Selected" now includes
  brought-in packs, so the old words would be wrong. They are entry-neutral
  because they also serve the catalog path, which has no `packs`.
- **`bounded/project` depends on the listed packs only, and a project
  contributes only to points of packs it lists**, even when a pack is
  brought in: ADR 2026-003 rule 1 ("a pack contributes only to points of
  packs directly in its `dependsOn`") applied to the project as to any pack
  (ADR 2026-010). No compile-time rule changes. Typing the closure was
  rejected: it would need a `Dependencies` parameter on
  `Pack<Id, Points, Ports>` and a recursive closure type in `ConfigSpec`, for
  a rule the user can satisfy by listing the pack.
- **The configuration has its own refusal for it.** Configurations reach run
  time without type checking (a `.ts` configuration loads through a
  type-stripping import, and `.js`/`.mjs` ones are allowed), so
  `Config.compose` checks, before composing, that every project
  contribution's point is owned by a listed pack, and says to add it to
  `packs` ("…which bounded.config.ts does not list in packs (it is selected
  only because 'D' depends on it). Add 'X' to packs, or remove the
  contribution"), or to contribute to the listed pack's point when the owner
  is another copy of it. Composition's direct-dependency rule stays as the
  backstop for every other pack.
- **`corePack` is implied like any other pack, only through `dependsOn`**,
  never added unconditionally (one plug-in mechanism, no special cases).
  Every pack that contributes guards depends on `corePack` (ADR 2026-007),
  so a selection that can decide anything already brings it in; a selection
  with no pack depending on it keeps the fail-closed refusal "No guards can
  be found: the core pack 'bounded/core' is not selected". A project that
  contributes to the core's points lists `corePack`.
- **A brought-in pack takes full part**: its points exist, its
  contributions are placed, its lifecycle checks run and its ports are
  required. "Selected" has one meaning.
- **Composition order is unchanged**: depth-first over the selection in id
  order, each pack after its dependencies. It depends only on ids and edges,
  never on whether a pack was listed or brought in, and `bounded/project`
  stays last.
- **Refusal order on the configuration path**: (1) packs not a list;
  (2) `SelectedPacks.parse`: a listed entry not built by definePack, a pack
  listed twice, two packs with one id; (3) a project contribution to a pack
  it does not list; (4) `Composition.compose`: an available pack with an
  invalid id, a selected pack that is malformed, declarations, then
  placement and contribution rules.
- **Renames** (AGENTS.md's naming rule, now that "selected" includes
  brought-in packs): `Config.selectedPacks` → `Config.listedPacks`;
  `Composition.compose`'s parameter `selectedPacks` → `listedPacks`;
  compose-packs' wire and command field `selectedPackIds` →
  `listedPackIds`.
- **`bounded init` writes `packs: [pathGate]`**: the path gate brings in the
  core. `bounded update` never touches an existing configuration, and
  `[corePack, pathGate]` keeps working.

## Release

The maintainer chose to ship this in the pending, unpublished 3.1.0 as a
second deliberate break in a minor release, with no version bump. Against
the published 3.0.0 it breaks three things: `Config.selectedPacks` (now
`listedPacks`); compose-packs' wire field `selectedPackIds` (now
`listedPackIds`); and the meaning of the exported `SelectedPacks.packs`
(now every selected pack, listed and brought in; `listedPacks` is added).

## Consequences

- A configuration that composed before composes the same, in the same
  order, with the same guard order. One refused for an unlisted dependency
  now composes.
- A project that contributes to a brought-in pack's point is refused until
  it lists the pack: at compile time when the configuration is type
  checked, and when it is used otherwise.
- The compile-time fixtures gain lines pinning that rule for a brought-in
  pack (`config-rejected.ts`, `path-gate-rejected.ts`), and
  `config.test.ts` holds its run-time refusal tests.
