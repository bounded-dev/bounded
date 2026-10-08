# 2026-002: Typed extension points, and where they depart from the example

**Status:** superseded in part by [ADR 2026-003](2026-003-packs-refer-to-packs.md): packs now refer to each other as objects, `definePack` replaces `new Pack`, `ExtensionPoint.ownedBy` and `new Contribution`, and literal pack names are no longer needed. The deviations from the example listed below still apply.

## Decision

Extension points are generic entities: `ExtensionPoint<Value, Owner>`, where
`Owner` is the owning pack's name as a string literal type and `Value` is a
phantom, invariant type. Packs are built with `new Pack({ name, dependsOn,
declares, contributes })`. `Name` and the dependencies are inferred only from
`name` and the `dependsOn` tuple (`NoInfer` keeps a contribution from widening
them); `declares` accepts only points owned by `Name`, and `contributes` only
contributions to points owned by `Name` or a listed dependency. A dependency's
dependency is not enough.

Every pack name, point owner and dependency must be one string literal:
`string`, a union or a template pattern would switch the check off, so
`OneLiteral` (`packs/one-literal.contract.ts`) turns each into a compile error
that says "write pack names as single string literals". Naming dependencies
as type arguments without writing `dependsOn` does not compile either. The
check is a type-level guarantee for code that does not cast; a cast
(`as never`) can still defeat it, which is why composition repeats it.

Composition repeats every check at run time, for packs built from untyped
data. It accepts only genuine packs, extension points and contributions (made
by `new Pack`, `ExtensionPoint.ownedBy(...).declare(...)` and
`new Contribution`, checked with `instanceof`) and refuses a malformed pack
naming it, never throwing. A contribution is plain data (a point and values);
composition places it only on the very point object its owner declared and
runs that point's own check on each value, refusing a value whose check
throws. That is why the single cast in `Composition.read` is sound: every
value in a slot came from a genuine contribution built against that slot's
point, whose constructor typed it as the point's `Value`. Composition is
synchronous and returns `Result`; reading a point that does not exist is an
error, never an empty list.

Duplicate names count among all available packs, selected or not: a name must
identify one pack, and the refusal is reported in name order.

Prior art: the legacy harness's `legacy/agent/src/socket-registry.ts`.

## Deviations from the hexagonal worked example

- **Generic contracts and function values in the domain.** The example's
  value objects are plain data; an extension point carries a value type and
  an optional `check` function, and a contribution carries arbitrary values.
- **Factories other than `parse(raw: unknown)`.** `ExtensionPoint.ownedBy(owner).declare<V>(spec)`
  writes the owner once and takes the value type explicitly; TypeScript has
  no partial type-argument inference that would allow both in one call. The
  factories also expose `isPack`, `isExtensionPoint`, `isContribution` and
  `checkValue` for composition.
- **Entities without an id value object.** Points, contributions and packs are
  equal by identity; packs are named by a literal string so the compiler can
  check ownership, and the name is validated as a `PackName` when selected.
- **Synchronous domain reads.** `Composition.compose` and `read` do no I/O; only
  the feature's out port (the pack catalog) is async.
- **The compile-time check is proved by fixtures, not `@ts-expect-error`.**
  `compile-time.test.ts` compiles every file in `test/fixtures/compile-time/`;
  each line marked `// rejected: <reason>` must be covered by an error whose
  message contains the reason, and no other line may fail. `@ts-expect-error`
  would pass on any error, including a typo, and cannot show that the accepted
  cases compile.
- **Hand-written laws, and no domain laws suites.** The example generates
  `*.laws.test.ts` for each value object and command. Here the command laws
  are written by hand, and `PackName` and `ExtensionPointId` have boundary
  tests (`*.test.ts`) but no laws suites; the laws that matter for them
  (parse accepts and refuses, the wire form is the value) are in those tests.
- **A shorter architecture test.** It keeps the example's rules that apply
  here (layers, imports through export paths, cross-context imports only over
  a declared package dependency, no I/O and no library but zod in domain and
  application) and drops those for apps, browsers and in adapters, which this
  library does not have yet.

## Consequences

A pack's name must be written as a literal (or a `const` holding one) at its
definition. A contribution or pack made any other way than through its
constructor is refused at composition. Reading with a second copy of a point
(for example from a duplicated package) is refused rather than read with the
wrong type. Contributed values are not deep-frozen: the lists are, the values
are the contributor's.
