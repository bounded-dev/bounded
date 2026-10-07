# 2026-002: Typed extension points, and where they depart from the example

**Status:** accepted

## Decision

Extension points are generic entities: `ExtensionPoint<Value, Owner>`, where
`Owner` is the owning pack's name as a string literal type and `Value` is a
phantom, invariant type. Packs are built with `new Pack({ name, dependsOn,
declares, contributes })`, whose `declares` accepts only points owned by
`Name` and whose `contributes` accepts only contributions to points owned by
`Name` or a `Dependency`. `NoInfer` keeps the compiler from widening those
types to fit a bad contribution, and a name widened to `string` is itself a
compile error. Composition repeats every check at run time for packs built
from untyped data, and places a contribution only on the very point object its
owner declared, which makes the single cast in `Composition.read` sound.
Composition is synchronous and returns `Result`; reading a point that does
not exist is an error, never an empty list.

Prior art: the Bounded harness's `agent/src/socket-registry.ts`.

## Deviations from the hexagonal worked example

- **Generic contracts and function values in the domain.** The example's
  value objects are plain data; an extension point carries a value type and
  an optional `check` function, and a contribution carries arbitrary values.
- **Factories other than `parse(raw: unknown)`.** `ExtensionPoint.ownedBy(owner).declare<V>(spec)`
  writes the owner once and takes the value type explicitly; TypeScript has
  no partial type-argument inference that would allow both in one call.
- **Entities without an id value object.** Points, contributions and packs are
  equal by identity (the point object is the identity); packs are named by a
  literal string so the compiler can check ownership, and the name is
  validated as a `PackName` when it is selected.
- **Synchronous domain reads.** `Composition.compose` and `read` do no I/O and
  return immediately; only the feature's out port (the pack catalog) is async.
- **The compile-time check is proved by fixtures, not `@ts-expect-error`.**
  `compile-time.test.ts` runs the TypeScript compiler on
  `test/fixtures/compile-time/{accepted,rejected}.ts` and asserts that exactly
  the lines marked `// rejected` fail. `@ts-expect-error` would pass on any
  error, including a typo, and cannot show that the accepted cases compile.
- **A shorter architecture test.** It keeps the example's rules that apply
  here (layers, imports through export paths, cross-context imports only over
  a declared package dependency, no I/O and no library but zod in domain and
  application) and drops those for apps, browsers and in adapters, which this
  library does not have yet.

## Consequences

A pack's name must be written as a literal at its definition. A contribution
built by hand outside `new Contribution` is refused at composition. Reading
with a second copy of a point (for example from a duplicated package) is
refused rather than read with the wrong type.
