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
  test/                   the package's end-to-end tests: its examples opened as projects' configurations, its READMEs and schemas checked,
                          and test/example-scenarios.test.ts, which runs every example's scenarios (required)
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
  examples/<slug>.config.ts      at least one: a project's configuration
  examples/<slug>.scenarios.ts   beside each: its scenarios, the calls it judges with their full verdicts
```

Nothing else may sit in the directory, and nothing else in `examples/`:
each example has its scenarios, and each scenarios file its example.
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
- `## Examples`: each example, naming both its files as inline code, by
  file name (`` `keep-secrets-out.config.ts` `` and
  `` `keep-secrets-out.scenarios.ts` ``), with its purpose. What it does is
  in its scenarios, which the tests check and the catalogue shows: state no
  verdict here. A scenarios file is named nowhere else in the README, and
  Examples names none that is not in `examples/`.

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
 * What the example is for, in a sentence or two.
 */
export default defineConfig({
  packs: [prereqs],
  contributes: [contribution(prereqs.points.rules, [/* … */])],
});
```

- The TSDoc on the default export gives the title (its first line) and at
  most one paragraph of purpose (the rest); the catalogue build refuses
  more. What the example does goes in its scenarios.
- An example imports only `bounded/domain` and the shipped packs' own
  export paths (`bounded/<pack>`), never a relative path nor an internal
  path (`bounded/<pack>/adapters` and the like), and no file imports an
  example, tests included: an example is outside the pack's code (ADR
  2026-009).
- `src/core/composition-root/pack-examples.test.ts` opens each example as a
  project's `bounded.config.ts`, with the shipped packs' ports, and wants no
  problem: an example that drifts from the API fails the build.
- Examples ship in the package, and the package catalogue embeds each
  verbatim, with its scenarios; no declarations are emitted for them.

### Scenarios

Beside each example sits `examples/<slug>.scenarios.ts`, its scenarios
([ADR 2026-031](adr/2026-031-example-scenarios.md)): the calls the example
judges, step by step, each with the verdict or message it gets, in full.
They are tests: the package's tests run them, the catalogue carries them,
and nothing else states what an example does.

```ts
import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [
    {
      title: "A review of the current plan lets builder run",
      projectFiles: { ".agent-state/item/plan.md": "the plan\n" },
      steps: [
        { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "builder" }], callId: "b1" }, verdict: { kind: "refuse", reason: "…", redirect: "…" } },
        { toolUse: { tool: "subagent", effects: [{ kind: "delegate", agent: "plan-reviewer" }], callId: "r1" }, verdict: { kind: "allow" } },
        { toolResult: { tool: "subagent", effects: [{ kind: "delegate", agent: "plan-reviewer" }], callId: "r1", ok: true, delegatedAgentRuns: [{ finished: true, resolvedAgent: "plan-reviewer" }] }, afterToolMessage: null },
        { changeFiles: { ".agent-state/item/plan.md": "the plan, edited\n" } },
        { toolUse: { tool: "shell", effects: [{ kind: "execute", command: "make build" }] }, verdict: { kind: "allow" } },
      ],
    },
  ],
});
```

- A scenario is `{ title, projectFiles?, steps }`: a one-line title, the
  files its project starts with (by project path), and its steps, at least
  one a tool use. Its project's `bounded.config.ts` is the example; it
  writes no configuration at the project's root (`bounded.config.*`) and
  nothing under `.bounded/`, Bounded's own state (the parser refuses
  both), nor under `node_modules/`, where the runner installs bounded and
  the linked packages (the runner ends such a scenario with that problem).
  The runner writes and deletes only inside the scenario's project: a path
  that leads out through a link ends the scenario with a problem, and a
  link is deleted, never its target.
  `.git/` is the scenario's to write, a hook for instance.
- A step is one of `{ toolUse, verdict }` (a tool use, `{ role?, tool,
  effects, callId? }`, and the verdict it gets: `{ kind: "allow" }` or
  `{ kind: "refuse", reason, redirect }`, the full text),
  `{ toolResult, afterToolMessage }` (a tool's result, with `ok` and
  `delegatedAgentRuns`, and the message the agent is told after it, or
  null) and `{ changeFiles }` (files changed between steps: each to its new
  text, or null to delete it). Effects are the core's
  (`read`, `list`, `write`, `fetch`, `delegate`, `invoke`), but an execute
  effect is `{ kind: "execute", command, cwd? }`, never a reading: bounded's
  shell command reader reads it when the scenario runs, as a host does.
- The normal form, which the catalogue carries, writes every role, list
  filter and execute `cwd` (null for none) and the project files (`{}` for
  none); leave out what it writes as null.
- A scenarios file imports only `bounded/domain`, and nothing imports it.
  The tests load it as the catalogue build does (`NodePackModules`'
  `loadDefaultExport`) and run it with `runExampleScenarios` from
  `bounded/testing/example-scenarios`: give it the example's absolute path,
  the scenarios, `linkedPackages` (each package the example imports other
  than bounded, by name and directory; the runner links bounded itself),
  `stateHome` (handed to `ports`; a temporary one by default),
  `ports({ stateHome })` (the adapters a host provides) and
  `shellCommandReading` (bounded's reader, prepared; needed only by a
  scenario that runs a command). Its report gives, per judged step, what
  was expected and what came; a `problem` says why a scenario, or all of
  them, did not run.
- A shipped pack's scenarios are run by `src/test/example-scenarios.test.ts`;
  a published pack's package runs its own in `test/example-scenarios.test.ts`,
  as a package outside this repository does.
- Cover each of the example's rules with at least one step: refused where
  it applies, allowed where its carve-outs leave a call out. This is a
  review item; nothing checks it mechanically.
- `ExampleScenarios.markdown()` renders them for a reader of the
  catalogue: each step's effects and call id, then "→ allowed",
  "→ refused: <reason>" with its redirect, or the message after a result.

## The package catalogue

A package that ships packs ships a catalogue of them, `bounded.catalog.json`
([ADR 2026-029](adr/2026-029-package-catalogue.md)), built by
`bounded catalog build` in the package's directory. bounded's prepack runs
it after building `dist/`; a pack's own package runs it the same way, in its
prepack. It joins each pack object (its id, dependencies, points,
contributions and ports), the TSDoc of its overview and contract, its
README and its examples with their scenarios, and fails closed: a missing
README section, a missing example, an example without its scenarios (or
scenarios without their example), scenarios that do not parse (named by
file, scenario and step), an example's TSDoc past one paragraph of purpose,
an Examples section that does not name both files of each example, a
contract that disagrees with the pack object, or a missing library is
refused, and nothing is written. It stores the scenarios; it does not run
them, so a catalogue shows checked verdicts only when the package's tests
run them. It loads each scenarios file under Node, which strips its types
(tested on Node 24 and 26; Node 22.18, the engines floor, is untested for
it; never a file under `node_modules`, where Node refuses).

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
