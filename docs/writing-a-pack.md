# Writing a pack

A pack shipped in `bounded` lives in its own directory, `src/packs/<name>/`
([ADR 2026-009](adr/2026-009-path-gate-pack.md),
[ADR 2026-024](adr/2026-024-src-layout.md)). Every pack has the same
structure, which rule R7 of the architecture test keeps
([ADR 2026-013](adr/2026-013-restructure.md), amended by `pack-structure`).
The two shipped packs, `src/packs/protected-paths/` and `src/packs/prereqs/`,
are worked examples.

## The directory

```
src/packs/<name>/
  <name>.pack.ts          the overview: definePack's sections (id, dependsOn, points, contributes, ports), bound from imported names, no logic
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
configuration lives in the examples, where the tests check it.
`src/core/composition-root/pack-readmes.test.ts` checks all of this.

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
  problem: an example that drifts from the API fails the build.
- Examples ship in the package, so the catalogue (issue #68) can carry
  them; no declarations are emitted for them.
