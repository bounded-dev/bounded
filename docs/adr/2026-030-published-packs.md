# 2026-030: Two kinds of pack: shipped in `bounded`, or published as a package of its own in `src/published-packs/<name>/`

**Status:** accepted (issue #69; the plan's two review rounds, and the
maintainer's answer on versioning, marked below). No change to what
`bounded` ships, so no version bump. Amends
[ADR 2026-016](2026-016-cli-app.md) (published packs are built and released
on their own; bounded's build is unchanged) and
[ADR 2026-024](2026-024-src-layout.md) (`src/` gains `published-packs/` and
`build-published-pack.ts`; the unit model gains a published pack and a
published pack's package's `test/`; the workspaces gain
`src/published-packs/*`). Amended by
[ADR 2026-032](2026-032-catalogue-build-on-bun.md): a package's prepack
runs the catalogue build with bun.

## Context

The monorepo published exactly one package, `bounded`. Every other workspace
is private and bundled into `bounded`'s `dist/` (ADR 2026-016), and the only
place for a pack was `src/packs/<name>/`, bundled by definition. The
architecture test requires every file to belong to a known unit, so a pack
published as its own npm package had nowhere to live.

Some packs should not be bundled. A pack tied to one vendor or one language
would make every project install its libraries, and would couple `bounded`'s
releases to that library's. Two are planned: `bounded-jev` (semantic checks
of tool calls with TypeSafe AI's JEV decision model through the Vercel AI
Gateway, the `ai` package's experimental `experimental_decide`) and
`bounded-ts-lint` (structural lint rules on TypeScript as it is written,
which needs a TypeScript parser). Both are deliberately vendor- or
language-specific: a neutral "judge pack" with pluggable adapters was
considered and rejected by the maintainer, and is not to be reintroduced.

## Decision

### Two kinds of pack, and the rule for choosing

- A **shipped pack** is bundled into `bounded`, in `src/packs/<name>/`
  (ADR 2026-009, unchanged). Shipped packs are generic and need no heavy or
  vendor library: `bounded/protected-paths`, `bounded/prereqs`.
- A **published pack** is its own npm package, `bounded-<name>`, in
  `src/published-packs/<name>/`. Published packs are tied to one vendor or
  one language, such as the planned `bounded-jev` and `bounded-ts-lint`.

The code and earlier ADRs already say "shipped pack"; it is not renamed
"bundled pack", which would retitle dozens of cases for no change in
behaviour. Prose says "shipped (bundled into bounded)" where the two meet.

### The slot, the name and the package's layout

- `src/published-packs/<name>/` is one npm package, a workspace
  (`src/published-packs/*` in the root `workspaces`). It is under `src/`,
  as ADR 2026-024 requires, and not under `src/packs/`, which bounded's
  `files` ships and its declaration build includes.
- The directory is the package's name without its `bounded-` prefix
  (`src/published-packs/jev` holds `bounded-jev`), unscoped: the project owns
  no npm scope (ADR 2026-004). The architecture test checks it.
- A package holds its packs in `packs/<pack>/`, each exactly a shipped
  pack's directory (R7: overview, contract, index, their test, README,
  `domain/`, `application/`, `adapters/`, `examples/`), beside
  `package.json`, `README.md` (the npm page), `LICENSE` and an optional
  `test/`; nothing else is tracked at its root. A pack cannot sit at the
  package root: ADR 2026-029's `PackageManifest.parse` refuses `"."` as a
  pack directory, and the layout is the one `docs/writing-a-pack.md`
  prescribes to third parties. A package may hold several packs (#68).
- A published pack's files are a `pack` unit whose package is its own
  (`packageDir` `src/published-packs/<name>`), so every pack rule (R1 to R7,
  the hexagon, I/O only in `adapters/out/`, value objects per package)
  applies by construction through ADR 2026-024's one `unitByPath`. The
  package's `test/` is a unit of a new kind, `package`, outside the layers
  and the pack rules, as every unit's `test/` is.

### bounded is a peer dependency

`bounded` is a `peerDependency` and a `devDependency` (`workspace:*`), never
a `dependency`, which the architecture test refuses. A second copy of
`bounded` under a published pack fails the brand checks (ADR 2026-012): the
selection refuses the pack ("Listed pack '…' was not built with
definePack(...), or was built by a different copy of bounded"), so the
configuration cannot be used and every event is refused. The packaging test
installs such a copy and sees it refused.

### Imports

- A published pack's code imports, from `bounded`, `bounded/domain` only:
  never another export path (a shipped pack's included) and never a
  relative path into `src/`. It imports its own pack's files by relative
  path only, never through its own package's name, nor a relative path out
  of its pack; and libraries only when its package declares them
  (`dependencies`). The shipped-pack rule of ADR 2026-009 ("a pack depends
  on the domain only") thus holds for every pack.
- Its examples import as a project's configuration does: `bounded/domain`,
  the shipped packs' own export paths (`bounded/<pack>`) and its own
  package's pack export paths.
- Nothing outside a published pack's package imports it, by name or by
  relative path into `src/published-packs/<name>/`, from any file of the
  repository (the core, the shipped packs, the libraries, the apps,
  `src/test/`, every unit's `test/`), and no other workspace's
  `package.json` names it: a host importing one would couple `bounded`'s
  release to it.
- Depending on a shipped pack, or on another published package, is deferred
  until a consumer needs it and an ADR says how.

### Build and packaging

- Each export has three conditions, as bounded's (ADR 2026-016): `bun` (the
  TypeScript source), `types` (declarations in `dist/types`, mirroring the
  package) and `default` (JavaScript for Node in `dist/`, mirroring it).
- One shared build, `src/build-published-pack.ts`, beside
  `src/build-dist.ts`, builds every package: each export's `default` from
  its `bun` source (code-split, every package import external), and its
  declarations with tsc against bounded's **built** declarations (without
  the `bun` condition, so `bounded/domain` resolves to `src/dist/types`, as
  a consumer's tsc resolves it; with the condition tsc would pull bounded's
  sources into the program). Relative `.ts` specifiers in declarations
  become `.js`. It refuses a built import that is not `node:*`, bounded's,
  the package's own or one of its `dependencies` ("… which is neither
  node's, bounded's, <package>'s nor one of <package>'s dependencies: add it
  to <package>'s dependencies"), and refuses to run before bounded's
  declarations exist ("bounded's declarations are not built
  (src/dist/types is missing): build bounded first with bun
  src/build-dist.ts"). bounded's own build and its refusals are unchanged.
- A package's prepack is `bun ../../build-published-pack.ts && bun
  ../../dist/cli.js catalog build` (under bun, ADR 2026-032), mirroring bounded's: it runs this
  checkout's built CLI, and applies ADR 2026-029's README and example rules
  at pack time. Each package carries its own catalogue (the `bounded` field,
  the `bounded-pack` keyword, the generated, gitignored
  `bounded.catalog.json`), so #68's "packages the project explicitly
  includes" maps one to one onto published packages.
- A package's `dist/` is build output wherever bounded's is: outside the
  architecture scans and `tsconfig.json`'s program.
- The test preload builds every published package's `dist/` after
  bounded's, as the architecture test checks every export target exists.
- `src/test/published-pack-packaging.test.ts` packs each published package
  once and installs it beside `bounded` (linked to `src/`): its manifest,
  its tarball's contents, its catalogue, judging under Node, the second copy
  refused, and a consumer's tsc against its packed declarations.

**bounded's tarball holds nothing of `src/published-packs/`.** Checked
before the tests were written, with a throwaway package
`src/published-packs/probe/` holding `package.json`, `README.md`, `LICENSE`,
`bounded.catalog.json`, `dist/a.js` and `packs/a/a.ts`: `bun pm pack
--dry-run` in `src/`, under bun 1.3.14, with and without the prepack, listed
no path under `published-packs/`. bun anchors bounded's `files` patterns
(`dist`, `packs`, `README.md`, `bounded.catalog.json`) at the package root,
so bounded's `files` gains no `"!published-packs/**"`. A packaging case pins
it.

### Versioning (decided by the maintainer)

Each published package is versioned and released independently, from
`0.1.0`. Its `peerDependencies.bounded` is exactly `~<major>.<minor>.0` of
`src/package.json`'s version (`~3.3.0` today), moving to `^` once `bounded`
keeps semver within a major. The packaging test asserts that exact string,
so a `bounded` minor bump fails `bun run check` until every published pack's
peer follows, and its tests pass against the new `bounded`.

### Private until released; the example is a fixture

A published package stays `"private": true` until it is ready to release,
which makes "not published" mechanical. The slot's example,
`bounded-example` in `src/published-packs/example/`, is a fixture that is
never published. Its pack, `bounded-example/refused-tools`
(`refusedToolsPack`), refuses every tool use of the tool kinds a project
lists in `refusedTools`, each with a redirect. A genuinely useful pack with
no port and no library would be generic, and the rule above puts generic
packs in `bounded`; JEV needs a port, and ts-lint a parser library. A rule
names a tool kind (`read`, `search`, `edit`, `write`, `shell`, `web`,
`subagent`, `other`), because host-neutral events carry the kind of tool,
never a host's own tool name: a rule naming one is refused, since it could
never match. The pack keeps its own list of kinds (the core exports the
type, not the list); were the core to add a kind, a rule naming it would be
refused until the list follows, which fails closed.

### Ports

A published pack may declare ports and adapters (R1 and R2 apply), but no
host provides them until a later item lets `bounded.config.ts` provide
ports: a project selecting such a pack has every event refused, naming the
pack and the port (`openProject`'s existing behaviour). The package's
`test/` may pass its own adapters to `openProject`.

### The package's `test/`

A published package's end-to-end tests are in its `test/`: they open its
examples as projects' configurations (the role
`src/core/composition-root/pack-examples.test.ts` plays for the shipped
packs, which may not reach a published pack), and run ADR 2026-029's README
rules and wire-schema checks over its packs (the role of
`pack-readmes.test.ts` and `pack-wire-schemas.test.ts`).

## Consequences

- Vendor- and language-specific packs can live in this repository, tested
  with the core, without `bounded` depending on their libraries.
- `bun run check` packs every published package: about 8 to 10 seconds for
  the example's packaging test, more for a package with more packs.
- Every `bun test` invocation, a single file's included, runs one tsc
  declaration emit per published package in the preload.
- A `bounded` minor bump fails the check until every published pack's peer
  follows.
- A published pack's installed code (`node_modules/bounded-<name>/**`) is
  not covered by `bounded init`'s default rules, which protect only
  `node_modules/bounded/**`: part of the known gap on the modules a
  configuration imports (`docs/flight-state.md`). `bounded init` and
  `update` do not install, upgrade or protect published packs.
- Discovery (#68's later steps) is not part of this decision.
