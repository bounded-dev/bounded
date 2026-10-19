# 2026-032: The package catalogue build runs under bun, and loads the JavaScript Node would load

**Status:** accepted (item `catalog-build-on-bun`; the maintainer's decision
that the catalogue build runs under bun, and the plan's review). Ships in
`bounded` 3.3.0, unreleased, with no version bump of its own. Amends
[ADR 2026-016](2026-016-cli-app.md) (bun is needed to build bounded and to
build any package's catalogue; the hooks, `init`, `update` and the library
need none), [ADR 2026-029](2026-029-package-catalogue.md) (the build runs
under bun; its adapter is `BunPackModules`; how the export-entry rule
loads), [ADR 2026-030](2026-030-published-packs.md) (a published package's
prepack runs the build with bun) and
[ADR 2026-031](2026-031-example-scenarios.md) (its section on loading under
Node).

## Context

`bounded catalog build` (ADR 2026-029) loads each example's
`<slug>.scenarios.ts` (ADR 2026-031) with a plain `import()`. Under Node
that rests on Node's TypeScript type stripping, which ADR 2026-031's spike
found working on Node 24 and 26, untested on the engines floor of 22.18,
and refused for any file under `node_modules` ("Stripping types is
currently unsupported for files under node_modules"). The build ran as
`node dist/cli.js catalog build` in both prepacks.

The maintainer has decided the catalogue build runs under bun, which loads
TypeScript natively, anywhere.

Hosts still load packs under Node: Claude Code's hook and pi run bounded's
`dist/`, and a pack package's export paths must give them JavaScript. Under
bun, resolving an export path by self-reference takes its `bun` condition,
the TypeScript source, so a build that resolved that way would pass a
package whose `default` target was never built.

## Decision

- **The build runs under bun only.** bounded's prepack is
  `bun build-dist.ts && bun dist/cli.js catalog build`; a published
  package's (ADR 2026-030) is
  `bun ../../build-published-pack.ts && bun ../../dist/cli.js catalog build`.
  Both keep the shipped bin, `dist/cli.js`, as what runs. A package outside
  this repository runs `bunx --bun bounded catalog build` in its prepack:
  `--bun` runs the package's local bin under bun despite its `node`
  shebang.
- **The CLI refuses under any other runtime, first.** `bounded catalog
  build` under Node exits 1 and writes nothing, printing
  `bounded: bounded catalog build runs under bun, and this is Node <version>:
  run it with bunx --bun bounded catalog build`. The usage text says the
  same. The CLI is an app, so it may name runtimes; the core does not.
- **The adapter is `BunPackModules`** (`src/core/adapters/out/pack-modules/pack-modules.ts`,
  in `bounded/adapters`), renamed from `NodePackModules` for the runtime it
  loads with. `bounded/adapters` is unreleased, so the rename breaks no
  published API. Both `load` and `loadDefaultExport` refuse, before reading
  anything, under any runtime but bun, saying to run under bun. It detects
  bun through `process.versions.bun` and uses no Bun API (runtime code uses
  none, `src/test/architecture.test.ts`), so the module still loads under
  Node, where hosts run the core.
- **It loads the JavaScript Node's require would pick, never a `bun`
  source.** From the package's own package.json it takes the export path's
  entry and its target under Node's conditions: a string is itself; a list,
  its first entry that gives a target; conditions, their keys in written
  order, the first of `default`, `require` or `node` that gives a target, at
  any depth. It joins that target to the package's directory, refuses a
  target outside the package, refuses a target that does not exist with
  "build the package first", and imports that file. A package with no
  `exports` still loads its root through `main`, as Node's require resolves
  it. The export path is no longer resolved by self-reference.
- **The export-entry rule (B1) stays**, refused before anything beyond
  package.json is read, reworded:
  `<name>'s export path <path> has no target Node's require picks (default,
  require or node): add a \`default\` condition naming its JavaScript, which
  hosts load under Node and the catalogue build loads too`.
- **Scenarios load as bun loads TypeScript**, `node_modules` included, so
  ADR 2026-031's limit under `node_modules` is gone.
- **The application port names no runtime.** `PackModules` loads "the
  JavaScript each export path's entry names for `default`, `require` or
  `node`, loaded by the runtime the build runs in"; the condition names are
  package.json's vocabulary, bounded's transport format, not a runtime.
- **`engines` gains no `bun`.** engines govern a consumer's install, and
  only someone building bounded or a package's catalogue needs bun. ADR
  2026-016's "Nothing needs bun at run time" and "Bun is needed only to
  build and publish" become: bun is needed to build bounded and to build any
  package's catalogue; the hooks, `init`, `update` and the library need
  none.

### What still needs Node

Nothing, to build a catalogue. Node remains the runtime the build's checks
serve: hosts load packs under Node, which is why the build loads each
export's Node target and refuses one never built. The bin's `node` shebang
only means a bare `bounded catalog build` is refused, with the command to
run.

### Direction: the standalone binary

Bounded is moving to a single executable built with `bun build --compile`
(the unmerged `standalone-binary` branch, whose `src/standalone-main.ts`
sends every command but `--version` and `hook claude-code` to
`runBoundedCli`). Once it exists, `bounded catalog build` runs under its
embedded bun, where the runtime check already passes. Loading a package's
packs and scenarios from disk there must bind their `bounded/*` imports to
the executable's own modules, as that branch's configuration loader does
with its runtime exports, or `parsePack`'s same-copy check refuses them.
That is a later change to this adapter or a sibling, not this decision's.

## Consequences

- The catalogue build no longer depends on Node's type stripping or its
  version; the engines floor no longer matters to it.
- A pack author needs bun to build their package's catalogue
  (`bunx --bun bounded catalog build`), as this repository's maintainers
  need it to build bounded.
- A package whose `default` target was never built is refused with "build
  the package first", rather than catalogued from source that hosts could
  not load.
- Under bun, `dist/cli.js`'s external `bounded/*` imports and a built
  pack's `bounded/domain` resolve through bounded's export paths to one
  copy, so `parsePack`'s same-copy check holds: bounded's own catalogue and
  bounded-example's build under `bun dist/cli.js` with empty stderr.
