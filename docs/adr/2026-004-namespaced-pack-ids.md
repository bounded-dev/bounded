# 2026-004: npm-namespaced pack ids, selection by pack objects

**Status:** accepted. Supersedes the id and selection parts of ADR 2026-003.

## Decision

- **A pack's id is `<npm package>/<local id>`**, made by one factory per npm
  package: `const packId = packIdsFor("bounded"); packId("core")` is
  `"bounded/core"`. The id is typed as its exact text and branded, so a plain
  string cannot stand in for it. The package part is an npm package name,
  scoped or not; the local part is lowercase words joined by hyphens, without
  `/`. Both are checked at compile time when written as literals, and the
  whole id at run time, always (`PackId.parse`, at composition). The id is
  the pack's label in selections, messages and logs; there is no other.
- **Why ids rather than symbols.** An id is readable and can be persisted: it
  appears in logs and messages, and future data-only packs can name their
  dependencies by it. npm already guarantees that package names are unique,
  and each package keeps the local ids of its own packs unique. Composition
  still refuses two available packs with one id.
- **Ownership at the type level is the exact id.** A contribution's point must
  be owned by a pack whose exact id is in `dependsOn`. A dependency whose id
  is not one exact literal (a pack upcast to `AnyPack`, cast with `as`, or a
  union of packs) does not compile. At run time packs are matched by object
  identity, never by id.
- **Selection is by pack objects.** `Composition.compose(available, selected)`
  takes pack objects for both lists. A wire input that names packs (the
  compose-packs feature) resolves each id to the catalog's pack before
  composing.
- **Points.** A point's check must return a precise type: `any` does not
  compile, because it would accept every value and spread `any` to readers.
  `unknown` is allowed: it is honest, and readers must narrow it. Point keys
  are camelCase (compile time: no `.`, `-`, `_`, `/`, space or `$`, and a
  lowercase first letter; run time: `^[a-z][a-zA-Z0-9]*$`), and a pack's
  points live on a prototype-free object, so a key such as `__proto__` is an
  ordinary key, refused as not camelCase. A check that accepts without
  returning a value refuses the value.
- **Package names.** The workspace package is `bounded`, the npm package this
  library becomes, so code imports `bounded/domain`; its pack ids root at
  `bounded`. Nothing uses an npm scope, because the project owns none.

## Known limits

- Two packs given the same id by their package are one type at compile time;
  composition refuses them when both are available, and matches every
  dependency by identity.
- Exactness is structural: a value held in a variable whose type has extra
  nested properties is assignable to the point's type (excess-property checks
  apply only to fresh object literals); the point's check sees the value.
- One `point(...)` declaration used in two packs gives each pack its own
  point, with the same check.
- The brand and the typed pack are asserted in three places inside the
  mechanism (`PackId.parse`, `packIdsFor`, `definePack`), and `read` asserts
  a point's stored values; none in pack code. A cast in pack code can defeat
  any compile-time rule; the run-time checks remain.

## Superseded tests

Tests that earlier red commits own and that this design replaces are
recorded in `superseded-tests.json` with their successors and reasons, which
the red-first check honours (see the development workflow).
