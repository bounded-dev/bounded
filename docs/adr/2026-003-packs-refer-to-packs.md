# 2026-003: Packs refer to each other as objects; strict typing is binding

**Status:** accepted. Supersedes the typing parts of ADR 2026-002. Its id and selection parts (labels, selection by label, string ids) are superseded by [ADR 2026-004](2026-004-namespaced-pack-ids.md).

## Decision

A pack is defined with `definePack({ id, dependsOn, points, contributes })`.

- **Dependencies are pack objects.** `dependsOn` is a tuple of the packs
  themselves, imported from their modules, so the import graph is the
  dependency graph. `id` is a label: it names the pack in selections and
  messages and must be a valid pack name (`PackName`: lowercase words joined
  by hyphens). That is why `PackName` stays.
- **Points are declared inside their pack.** `points: { key: point({ description,
  check, values }) }`. `definePack` makes each declaration a point owned by
  the pack it returns, so `pack.points.key` is typed
  `ExtensionPoint<Value, typeof pack>` and no separate identity object is
  needed. A pack's own values for its own point are given in
  `point({ values })`: the pack cannot name its own points while it is being
  defined, so `contributes` is only for points of packs in `dependsOn`.
- **A check parses.** `check: (raw: unknown) => Result<Value>` refuses a value
  with a message or returns the value to store, possibly normalised; the
  point's value type is what the check returns. Every point has one, so a
  value from untyped data is always checked against the point's type at run
  time. Composition stores what the check returns.
- **Selection is by label.** `Composition.compose(available, ["core", "path-gate"])`:
  a project's selection is data (a list of names in its configuration), so
  labels read best there; composition resolves each label to the one
  available pack that carries it, and refuses two available packs with one
  label.
- **Genuineness.** Packs, points, declarations and contributions are frozen
  plain objects recorded in a module-private `WeakSet`. Composition accepts
  only those, so a copy (`{ ...pack }`), a forgery, or an object made by a
  different copy of `@bounded/core` is refused, with a message that says so.

What can no longer be built, so needs no refusal: a dependency cycle (a pack
can only depend on packs that already exist, and packs are frozen), a pack
depending on itself, a point declared on another pack's behalf, and two
points with one id (ids are `<label>.<key>`, keys are dotless and unique in
their object, labels are unique). When data-only packs arrive, they will name
their dependencies by label; the cycle refusal returns with them.

## The strict-typing rule (binding)

Anything not explicitly wired fails to compile, and composition repeats each
rule at run time for packs built from untyped data. Every rule has a rejected
line in `contexts/core/test/fixtures/compile-time/rejected.ts` with the reason
its error must give, the legitimate form in `accepted.ts`, and a run-time
refusal in `composition.test.ts`:

1. A pack contributes only to points of packs **directly** in its `dependsOn`
   (not a dependency's dependency, not a point imported from a pack it does
   not list, not with an empty `dependsOn`); its own points get values
   through `point({ values })`.
2. A contributed value has exactly the point's value type, nested types
   included; points are invariant in their value type.
3. `dependsOn` is a tuple of distinct packs, each a single pack: no widened
   `BasePack[]`, no repeats, no unions, and type arguments cannot stand in for
   it.
4. Points are declared only inside their own pack, under camelCase keys
   without dots, each with a check; a pack's id is a string literal.
5. Reading a point is typed by the point object: no cast in caller code.

A static list of the points a pack contributes to (beyond its contributions)
is deferred: nothing consumes it yet.

## Known limits

- **Type identity is structural.** A pack's type is its label and its points'
  value types, made invariant. Two packs with the same literal label and the
  same point types are one type, so depending on an impostor with identical
  types compiles; composition refuses it (the dependency is not the selected
  pack with that label, or the contribution's owner is not in `dependsOn`).
- **Casts inside the mechanism, none in pack code.** `definePack` asserts that
  the object it builds is the `Pack<Label, Points>` its signature promises,
  and `Composition.read` asserts that a point's stored values have its value
  type (each was returned by that point's own check). A cast in pack code
  (`as never`) can defeat any compile-time rule; the run-time checks remain.

## Deviation from the example

Packs, points and contributions are frozen plain objects made by three
functions (`definePack`, `point`, `contribution`) typed by one
`PackFactory` contract, not `<Name>Impl` classes with a `new` factory: the
pack's points must exist before the pack is frozen and must point back at
it, and genuineness is tracked by the module, not by a class.

## Consequences

Pack modules import the packs they depend on, so a dependency on a pack is
visible in the import statements. Labels still matter at run time: they are
what a project selects and what every message names.
