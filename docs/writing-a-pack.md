# Writing a pack

A pack shipped in `bounded` lives in its own directory, `src/packs/<name>/`
([ADR 2026-009](adr/2026-009-path-gate-pack.md),
[ADR 2026-024](adr/2026-024-src-layout.md)). Every pack has the same
structure, which rule R7 of the architecture test keeps
([ADR 2026-013](adr/2026-013-restructure.md), amended by `pack-structure`).
The two shipped packs, `src/packs/protected-paths/` and `src/packs/prereqs/`,
are worked examples.

## Shipped or published

A pack is **shipped** in `bounded` when it is generic and needs no heavy or
vendor library, as `bounded/protected-paths` and `bounded/prereqs` are. A pack
tied to one vendor or one language (the planned `bounded-jev` and
`bounded-ts-lint`) is **published** as an npm package of its own, so a
project installs its libraries only when it wants the pack and `bounded`'s
releases do not follow that library's
([ADR 2026-030](adr/2026-030-published-packs.md)).

In this repository a published pack sits in its own package,
`src/published-packs/<name>/`, named `bounded-<name>`:

```
src/published-packs/<name>/
  package.json            bounded-<name>: bounded as a peerDependency (~<major>.<minor>.0) and a workspace:* devDependency
  README.md               the npm page
  LICENSE
  packs/<pack>/           each pack, laid out exactly as a shipped pack's directory (below)
  test/                   the package's end-to-end tests: its examples opened as projects' configurations, its READMEs and schemas checked
```

Its code reaches `bounded` through `bounded/domain` only, its own files by
relative path, and libraries its `package.json` declares; nothing outside
the package imports it. Each export has `bun`, `types` and `default`
conditions, and the package's prepack is
`bun ../../build-published-pack.ts && node ../../dist/cli.js catalog build`:
the repository's shared build, then this checkout's built CLI. A package
outside this repository runs `bounded catalog build` instead (see the
package catalogue, below). `src/published-packs/example/` (`bounded-example`,
a private fixture) is a worked example.

## The directory

```
src/packs/<name>/
  <name>.pack.ts          the overview: definePack's sections (id, dependsOn, points, contributes, ports, optionalPorts), bound from imported names, no logic
  <name>.contract.ts      the pack's type, which the overview is typed by
  <name>.pack.test.ts     the overview's test
  index.ts                what bounded/<name> exports
  README.md               required: the sections below
  domain/                 concepts and rules; no I/O
  application/            features: guards, lifecycle checks, the ports they need
  adapters/out/<port>/    the adapters a host provides for each port
  examples/<slug>.config.ts   at least one: a project's configuration
```

Nothing else may sit in the directory, and nothing else in `examples/`.
The pack also gets its export paths in `src/package.json`
(`./<name>`, and `./<name>/adapters` when it has ports).

## The README

The first line is `# <pack id>: <one-line summary>`, with the pack's exact
id (`# bounded/prereqs: an action needs a prerequisite`). These headings
appear once each, in any order, each with text under it; other `##`
sections are welcome:

- `## What it is for`: the problem it solves, in a project's words.
- `## Rule shape`: what a project contributes to each of its points, naming
  every point key as inline code (`` `rules` ``). A pack with no points says
  so.
- `## Workflows it fits`: the workflows it is meant for.
- `## What it observes`: the events and effects it judges, and its checks
  around tool calls.
- `## What it cannot see`: its limits, honestly: what it allows because it
  cannot see it, and what it refuses for the same reason.
- `## Ports`: what a host must provide through `openProject({ ports })`,
  naming every port key as inline code. A pack with no ports says so.
- `## Examples`: what each example file shows.

A README holds no project configuration (no fenced `defineConfig(`): the
configuration lives in the examples, where the tests check it. The package
catalogue build applies these rules (`PackReadme`, over marked's reading of
the README) and refuses a README that breaks one;
`src/core/composition-root/pack-readmes.test.ts` runs the same rules over
the shipped packs.

## Examples

Each example is `examples/<slug>.config.ts` (the slug in kebab case), a
complete project configuration, written exactly as a project's
`bounded.config.ts`:

```ts
import { contribution, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";

/**
 * Review the plan before building it
 *
 * What the example shows, in a sentence or two.
 */
export default defineConfig({
  packs: [prereqs],
  contributes: [contribution(prereqs.points.rules, [/* … */])],
});
```

- The TSDoc on the default export gives the title (its first line) and the
  description (the rest).
- An example imports only `bounded/domain` and the shipped packs' own
  export paths (`bounded/<pack>`), never a relative path nor an internal
  path (`bounded/<pack>/adapters` and the like), and no file imports an
  example, tests included: an example is outside the pack's code (ADR
  2026-009).
- `src/core/composition-root/pack-examples.test.ts` opens each example as a
  project's `bounded.config.ts`, with the shipped packs' ports, and wants no
  problem: an example that drifts from the API fails the build. The same
  file judges calls against each example's rules, before the tool runs:
  every rule refuses at least one call it covers, with its reason and
  redirect, and the calls its carve-outs leave out are allowed. A
  prerequisite rule is refused, then met by a review and allowed, then
  stale again once its files change. Shell commands there carry sample
  readings (the core cannot depend on the shell reader), so the infra
  example's claims about `sudo`, `env`, `bash -c` and `$TF apply` are
  covered with the real reader in
  `src/lib/shell-command-reader/composition-root/prereqs-shell-commands.test.ts`;
  drift is not exercised for examples. A new example needs its own case
  there, because a completeness case lists every example path.
- Examples ship in the package, and the package catalogue embeds each
  verbatim; no declarations are emitted for them.

## The package catalogue

A package that ships packs ships a catalogue of them, `bounded.catalog.json`
([ADR 2026-029](adr/2026-029-package-catalogue.md)), built by
`bounded catalog build` in the package's directory. bounded's prepack runs
it after building `dist/`; a pack's own package runs it the same way, in its
prepack. It joins each pack object (its id, dependencies, points,
contributions and ports), the TSDoc of its overview and contract, its
README and its examples, and fails closed: a missing README section, a
missing example, a contract that disagrees with the pack object, or a
missing library is refused, and nothing is written.

- **package.json.** List each export path that exports a pack, with the
  pack's source directory, in the `bounded` field, list the catalogue in
  `files`, and add the keyword `bounded-pack`:

  ```json
  {
    "keywords": ["bounded-pack"],
    "files": ["dist", "packs", "bounded.catalog.json"],
    "scripts": { "prepack": "<your build> && bounded catalog build" },
    "bounded": { "catalog": "./bounded.catalog.json", "packs": { "./my-pack": "packs/my-pack" } }
  }
  ```

  A pack exported from the package root is listed as `"."`. Each listed
  export path exports exactly one pack, whose id is rooted at
  the package's name (`packIdsFor("<package name>")`).
- **The export-entry rule.** The build loads each pack under Node, through
  the package's own export path. Its entry must have a `default`, `require`
  or `node` target naming JavaScript (`{ "./my-pack": { "types": "…", "default": "./dist/my-pack/index.js" } }`);
  an entry with only `import` is refused, asking for a `default`
  condition. A package with no `exports` may list its root, `.`, which
  loads through `main`. Build the package first.
- **The libraries.** Install `typescript` (major 5), `ts-json-schema-generator`
  and `marked` as devDependencies of the package: the build resolves them
  from it and refuses, naming the one missing. The generator must share the
  package's copy of typescript.
- **The tsconfig.** The build reads the package's `tsconfig.json`, found as
  `tsc` finds it, for its compiler options only; its program is the pack's
  overview, contract and examples alone. A package with no tsconfig is
  refused.
- **The contract.** The pack's type in `<name>.contract.ts` declares its
  points (`ExtensionPoint<Value, Id>`, each with TSDoc) and ports
  (`PortKey<Adapter, Id>`), and its optional ports in `optionalPorts`, with
  the same keys as the overview; `## Ports` names every one of them. A point's
  wire type (a value object's `toJSON` result, or plain data's own type,
  named or not) must be one ts-json-schema-generator can describe: the
  catalogue carries its JSON Schema. A point whose values are code carries
  none. The pack is an `export const` of its overview; its index may
  re-export it under any name.
