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
- **It resolves each export exactly as a host's `import()` does under
  Node, never to a `bun` source** (final review). Hosts load packs with
  `import()`, so the conditions are those of `import()` on Node at or
  above the engines floor (22.18): `node`, `import`, `module-sync` and
  `default`, taken in the entry's own key order, never `require` or `bun`.
  The adapter implements Node's documented ESM resolution algorithm for
  `exports` step for step (PACKAGE_EXPORTS_RESOLVE,
  PACKAGE_IMPORTS_EXPORTS_RESOLVE, PATTERN_KEY_COMPARE and
  PACKAGE_TARGET_RESOLVE in
  https://nodejs.org/api/esm.html#resolution-algorithm-specification), and
  follows Node's implementation where it is narrower than the text: a key
  ending in `/`, a folder mapping Node removed, is never matched. A library
  was tried first (`resolve.exports`) and dropped on re-review: it stops at
  a matched condition whose nested entry gives no target, where Node goes on
  to the next key, and it resolves folder mappings. So a matched condition
  that gives no target goes on to the next key; `null` means not exported;
  a target starts with `./` and has no `.`, `..` or `node_modules` segment
  after it (Node's throwing pattern; an empty segment, which Node only warns
  about, loads); within a list the invalid entries are skipped; `exports` of
  `null` is no `exports`. Subpath patterns (`"./*"`, `"./de*"`) are
  supported, the most specific key first, as Node orders them; the plan had
  left them out of scope, and the algorithm brings them in. It resolves the
  target as Node does, a URL against the package's directory
  (`fileURLToPath(new URL(target, pathToFileURL(packageDir + "/")))`, so
  percent-encoded characters are decoded), refuses an encoded `/` or `\`
  (`%2F`, `%5C`) as Node's `finalizeResolution` does, refuses a target
  outside the package, one that does not exist with "build the package
  first", and a folder, and imports that file. The export path is
  no longer resolved by self-reference, whose `bun` condition would load
  the source.
- **Without `exports`**, the package root loads through `main`, read from
  package.json (never bun's `require.resolve`, which may prefer other
  fields), and refused when it climbs out of the package; with no `main`,
  through `index.js`. **A stricter rule than Node's:** `main` must name an
  existing file, extension included. Node's legacy lookup (`main.js`,
  `main/index.js` and the like) is deprecated and not implemented, so an
  extensionless or folder `main` is refused.
- **Containment is checked by path.** A target or `main` is inside the
  package when its resolved path stays inside the package's directory;
  a symlink inside the package is followed, just as Node follows it.
- **The export-entry rule (B1) stays**, refused before anything beyond
  package.json is read, reworded:
  `<name>'s export path <path> is not exported to a host's import() under
  Node: it is null, or none of its node, import, module-sync or default
  conditions gives a target: add a \`default\` condition naming its
  JavaScript, which hosts load under Node and the catalogue build loads
  too`. An export path `exports` does not list (a folder mapping included)
  is refused as `<name> has no export path <path>: …`. A target Node throws
  on is refused naming it: `… names <target>, which Node refuses as a
  package target: a target starts with ./ and has no ., .. or node_modules
  segment after it`; Node's other errors (a pattern's invalid match, mixed
  or numeric keys) are refused in its terms.
- **Scenarios load as bun loads TypeScript**, `node_modules` included, so
  ADR 2026-031's limit under `node_modules` is gone.
- **The application port names no runtime.** `PackModules` loads "the
  JavaScript each export path resolves to under the conditions `node`,
  `import`, `module-sync` and `default`, loaded by the runtime the build runs in"; the condition names are
  package.json's vocabulary, bounded's transport format, not a runtime.
- **`engines` gains no `bun`.** engines govern a consumer's install, and
  only someone building bounded or a package's catalogue needs bun. ADR
  2026-016's "Nothing needs bun at run time" and "Bun is needed only to
  build and publish" become: bun is needed to build bounded and to build any
  package's catalogue; the hooks, `init`, `update` and the library need
  none.

### What still needs Node

Nothing, to build a catalogue. Node remains the runtime the build's checks
serve: hosts load packs under Node, which is why the build resolves each
export as a host's `import()` does under Node and refuses a target never
built. The bin's `node` shebang
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
  version: its runtime is bun, whatever the engines floor. Its resolution
  still models Node at or above the floor (22.18), whose `import()` matches
  `module-sync` (from Node 22.12).
- A pack author needs bun to build their package's catalogue
  (`bunx --bun bounded catalog build`), as this repository's maintainers
  need it to build bounded.
- A package whose `default` target was never built is refused with "build
  the package first", rather than catalogued from source that hosts could
  not load.
- **A known limit of its fidelity to pi.** pi loads a project's
  configuration, and so its packs, through jiti, which may take the
  `require` target of a dual `{ import, require }` entry where `import()`
  takes `import`. The build checks what a host's `import()` loads under
  Node, which is what Claude Code's hook loads; it does not check what pi
  loads when the two targets differ.
- Under bun, `dist/cli.js`'s external `bounded/*` imports and a built
  pack's `bounded/domain` resolve through bounded's export paths to one
  copy, so `parsePack`'s same-copy check holds: bounded's own catalogue and
  bounded-example's build under `bun dist/cli.js` with empty stderr.
