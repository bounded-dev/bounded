# 2026-031: Every pack example carries checked scenarios, `<slug>.scenarios.ts`, run by the package's tests and shown in its catalogue

**Status:** accepted (item `example-scenarios`; the plan's five review
rounds and the maintainer's answer on execute steps, marked below). Ships
in `bounded` 3.3.0, unreleased, with no version bump of its own. Amends
[ADR 2026-009](2026-009-path-gate-pack.md) (a shipped pack's examples gain
their scenarios, and nothing imports either),
[ADR 2026-013](2026-013-restructure.md) (R7: `examples/` holds each example
with its scenarios beside it),
[ADR 2026-029](2026-029-package-catalogue.md) (the catalogue's examples
carry their scenarios; the build refuses an example without them, a
scenarios file without its example, scenarios that do not parse, a TSDoc
that runs past its purpose and a README whose Examples section does not
name both files) and [ADR 2026-030](2026-030-published-packs.md) (a
published pack's package runs its scenarios in its own
`test/example-scenarios.test.ts`). Amended by
[ADR 2026-032](2026-032-catalogue-build-on-bun.md): the catalogue build
runs under bun, which loads scenarios files anywhere, `node_modules`
included.

## Context

A pack's examples (`examples/<slug>.config.ts`, ADR 2026-009) are complete
project configurations, and the catalogue (ADR 2026-029) embeds them. What
an example does was said twice in prose: in the example's TSDoc and in the
README's Examples section, and checked once more, by hand, in a case of
`src/core/composition-root/pack-examples.test.ts` per example. Nothing tied
the three together: a new example needed its own case, a README could claim
a refusal no test checked, and a catalogue reader saw prose, never checked
output.

The maintainer's goal: a pack's examples can never drift from what the pack
does.

## Decision

### Scenarios as data, beside the example

Each example `<slug>.config.ts` has a sibling `<slug>.scenarios.ts` whose
default export is `defineExampleScenarios({ scenarios: [...] })` from
`bounded/domain`. A scenario is `{ title, projectFiles?, steps }`: a one-line
title, the files its project starts with (by project path), and its steps,
at least one a tool use. A step is one of three, in the core's wire
vocabulary:

- `{ toolUse, verdict }`: a tool use (`{ role?, tool, effects, callId? }`,
  a tool use's wire form without its `kind`) and the verdict it gets, in
  full: `{ kind: "allow" }` or `{ kind: "refuse", reason, redirect }`;
- `{ toolResult, afterToolMessage }`: a tool's result (a tool result's wire
  form without its `kind`, with `ok` and `delegatedAgentRuns`) and the
  message the agent is told after it, or null;
- `{ changeFiles }`: files changed between steps, by project path, each to
  its new text, or null to delete it.

An execute effect in a scenario is **a command still to be read**,
`{ kind: "execute", command, cwd? }`, never a reading (maintainer: Q1 (b)).
The runner reads it when the scenario runs, in that scenario's project,
with bounded's real shell command reader, as a host does; so a scenario
cannot hold a hand-made reading that the reader would never give. The core's
`ExecuteEffect` and ADR 2026-020 are unchanged.

There is no agent-run-finish step, no SessionStart step and no step whose
expected text holds a wall-clock time: none is needed yet, and each is
added when one is.

### The scenario type lives in the core's domain, as mechanism

`ExampleScenarios` (`src/core/domain/catalog/example-scenarios.*`) is a
value object (ADR 2026-012) exported from `bounded/domain` with
`defineExampleScenarios` and the wire types. It names no host or
technology and holds no opinion: it is the core's own event vocabulary
plus a step wrapper. The catalogue build, a core feature, parses it.

Each part of a scenario is checked by the parser that already owns it,
keeping its message, so a scenario is refused exactly as a host's event
would be:

- a call's role, tool kind, effects and call id by `callOf`, which gains an
  effect-reader parameter: `Call<E>` and `callOf<E>` are generic in their
  effects, a deviation under ADRs 2026-002 and 2026-003 (an event's effects
  are `Effect`s, a scenario's are effects whose execute effects are
  commands still to be read); callers pass `Effect.parse` for an event;
- every effect but an execute by `Effect.parse`;
- an execute command's shape (exactly `kind`, `command` and `cwd`; a
  `reading` is refused with "leave its reading out") by
  `ExampleScenarios.parse`, then its command and cwd by `commandToReadOf`,
  which holds only the execute effect's own checks and which the execute
  effect's own parse now calls;
- a verdict by `Verdict.parse`;
- a tool result's `ok` with the message `ToolResult.parse` gives
  (`TOOL_RESULT_SAYS_OK`), and its `delegatedAgentRuns` by
  `delegatedAgentRunsOf`.

One function, `describeExecute`, words an execute command, for
`describeEffect` and the scenarios' rendering alike.

`ExampleScenarios.parse` is strict for authored files: every refusal names
the scenario (its number and title) and the step (its number), and it
refuses unknown fields, a blank or multi-line title, a scenario with no
tool use, the project's root as a file, a file named twice (`a.txt` and
`./a.txt`), and a project file or changed file where Bounded keeps its
own: the project's configuration at its root (any name starting
`bounded.config.`, ignoring case: the list of configuration names lives in
the core's adapters, which the domain may not import, and the prefix covers
it), or anything under `.bounded`, ignoring case. The domain names no
other directory (final review): `.git/` is a scenario's to write, so a
git-hooks pack can ship a scenario whose project holds
`.git/hooks/pre-commit`; `node_modules/` is reserved by the runner, which
installs packages there (below).

A step's type in TypeScript is a union of the three kinds without mutual
exclusions, so that a tool use step without its verdict fails to compile
with "Property 'verdict' is missing". A step that gives two kinds
(`{ toolUse, verdict, changeFiles }`) therefore compiles, and is refused
only at run time, by `ExampleScenarios.parse`.

`toJSON()` gives the **normal form**: every role, list filter and execute
`cwd` written (null for none) and the project files written (`{}` for
none). Authors may leave out what the normal form writes as null.

`defineExampleScenarios` is a typed identity that freezes the plain data
all the way down and returns it. Plain data parses the same in any copy of
`bounded`, the trap the catalogue met with `parsePack` (ADR 2026-029).

### Who may import a scenarios file, and what it imports

A scenarios file imports only `bounded/domain`, in a shipped and a published
pack alike. Nothing imports an example or its scenarios, the tests
included; the architecture test's message is now "nothing imports a pack's
example or its scenarios: open the example as a project's configuration,
and run its scenarios with bounded/testing/example-scenarios". The runner's
callers and the catalogue build read a scenarios file by its computed path,
through `PackModules.loadDefaultExport`, an out adapter (the only layer that
may load code chosen at run time).

### The runner: `bounded/testing/example-scenarios`

`runExampleScenarios` (`src/core/composition-root/run-example-scenarios.test-support.ts`)
is published bun-only as `bounded/testing/example-scenarios`. It uses no
test framework and no git. Its options are the example's absolute path, the
raw scenarios, `linkedPackages` (other packages the example imports, by
name and directory), `stateHome`, `ports({ stateHome })` and
`shellCommandReading`. For each scenario it makes a project in a temporary
directory (the example as its `bounded.config.ts`, the project files),
links `node_modules/bounded` itself to the `bounded` it ships in (two
directories above its own file), so it always runs against that `bounded`
(a `bounded` key in `linkedPackages` is refused), opens the project as a
host does, and runs the steps, reporting for each judged step what it
expected and what it got. Projects are removed after, their links with
them, never what they point at.

- `stateHome` is handed to `ports`; left out, the runner makes a temporary
  one and removes it after. No run writes the user's real state directory.
- Scenarios that do not parse are the report's top-level `problem`, with
  the parser's error: no project is made, and neither `ports` nor the
  reader is called. So are a `linkedPackages` directory that does not
  exist and an example that cannot be read.
- A scenario that writes or deletes a file under `node_modules/` (ignoring
  case), where the runner installs bounded and the linked packages, ends
  with that problem, and none of its steps runs.
- Defence in depth, beside that guard (re-review: without it, a test that
  deleted `Node_Modules/bounded/package.json` followed the `bounded` link,
  macOS resolving the case, and deleted bounded's own `package.json`):
  before any write or delete, the runner resolves the real path the file
  leads to (its parent's through every link, and a link's target when a
  link is written through) and ends the scenario with a problem naming the
  path when it is outside the project root's real path. A link is deleted,
  never its target. No gap in a guard can reach outside the project.
- A `linkedPackages` name that is not a package's name (`name` or
  `@scope/name`, no `.` or `..` segment) is the report's problem.
- A scenario whose project does not open, or that runs a shell command
  when no reader was given, ends with that problem, and none of its steps
  runs.

### Shipped and published packs alike

The format, R7's sibling rule, the import rule, the README and TSDoc rules,
the catalogue field, the runner and the red-first guard are the same for a
shipped and a published pack. Who runs the scenarios differs:

- a shipped pack's are run by `src/test/example-scenarios.test.ts`, with the
  shipped packs' ports, a temporary state home and bounded's shell command
  reader (from the workspace source, prepared first, 30 s bounds);
- a published pack's package runs its own, in
  `test/example-scenarios.test.ts`, through `bounded/testing/example-scenarios`:
  ADR 2026-030 forbids anything outside the package from reaching it. This
  is exactly the route a package outside this repository takes. The
  architecture test requires every published package here to have that
  test, importing the runner.

### Completeness, enforced twice

- In this repository, R7 (the architecture test) requires each
  `examples/<slug>.config.ts` to have its `examples/<slug>.scenarios.ts`
  beside it, and refuses scenarios without their example.
- For every package, this repository's and third parties', `bounded catalog
  build` refuses, failing closed, an example with no scenarios file, a
  scenarios file with no example, and scenarios that do not parse, naming
  the file and the step.

The build stores scenarios; it does not run them. A third party's
catalogue shows the verdicts its scenarios declare, checked only if its
tests run the published runner. In this repository the published-runner
rule closes that gap.

### The catalogue carries data; `markdown()` is the one rendering

Each catalogued example gains `scenarios`, in their normal form, and the
catalogue holds no second representation. `catalogVersion` stays 1: no
catalogue has been released. `PackageCatalog.parse` checks only that each
example has a non-empty list of scenarios, each with a non-empty list of
steps, and keeps them as given; a reader parses them with
`ExampleScenarios.parse({ scenarios })`.

`ExampleScenarios.markdown()` is the one canonical rendering that every
catalogue reader (a registry, `bounded packs show`, the website) uses:

```
### <title>

Project files: `<path>`, `<path>`.

1. <effects> → allowed
2. <effects> → refused: <reason>
   Redirect: <redirect>
3. Result of <effects>, succeeded; <agent>'s run finished → no message
4. Files changed: `<path>`; deleted: `<path>`.
```

`<effects>` are the step's effects as messages name them, joined by `; `,
then ` (call <callId>)` when it has one. "Project files" is left out when
there are none; "changed" and "deleted" each appear only when non-empty.
Scenarios are separated by one blank line.

### Prose shrinks to a title and a purpose

- An example's TSDoc is a one-line title and at most one paragraph of
  purpose; the build refuses more ("put what it does in
  `<slug>.scenarios.ts`"). Behaviour claims moved into scenarios or went.
- A README's Examples section names both files of each example,
  `<slug>.config.ts` and `<slug>.scenarios.ts`, as inline code, by file
  name; a scenarios file it names that is not in `examples/` is refused, and
  so is a scenarios file named in any other part of the README. Other
  configuration names (`bounded.config.ts`) are not policed. The README
  names the examples and points at their scenarios and the catalogue, so
  nothing committed can disagree with what is checked.

### The lifecycle

Scenarios are tests (ADR 2026-001, amended by `red-first-scenarios` and
`red-first-published-scenarios`): they sit in the red commit, and only
test-only commits change them afterwards. The red-first check's fixture
runners gain a shipped pack's scenarios (run by
`src/test/example-scenarios.test.ts`), a published pack's (run by its
package's `test/example-scenarios.test.ts`) and the runner's own fixture
package (run by `run-example-scenarios.test.ts`); a catalogue fixture's
scenarios run no test. A runner named by a fixture's path is run at the red
commit only when it exists there; a published package that ships scenarios
without its runner is refused at the head by the published-runner rule,
where `bun run check` must pass, so this is not fail-open.

The per-example cases of `pack-examples.test.ts` are recorded as
superseded: the completeness case by R7's sibling rule, the five
per-example cases by their scenarios files, with no successor case.

### Loading scenarios

The catalogue build loads a `<slug>.scenarios.ts` with a plain `import()`.
It first ran under Node (`node dist/cli.js catalog build`), through Node's
TypeScript type stripping, which a throwaway spike found working on Node 24
and 26, untested on Node 22.18 and refused under `node_modules`. Since
[ADR 2026-032](2026-032-catalogue-build-on-bun.md) it runs under bun
(`bun dist/cli.js catalog build` in bounded's prepack and in each published
package's), which loads TypeScript natively, `node_modules` included, and
refuses under Node. The spike, kept as history, recorded:

- Node v24.18.1 (and v26.5.0): in `src/` and in `src/published-packs/example/`
  the build loads every scenarios file, exits 0, and writes nothing on
  stderr (no `ExperimentalWarning`). Loading scenarios is tested on Node 24
  and 26 only; Node 22.18, the engines floor, is untested for it.
- Under `node_modules`, Node refuses: "Stripping types is currently
  unsupported for files under node_modules". The build runs in a package's
  own directory, never in an installed copy, so this is a limit, reported
  as the build's refusal.

## Consequences

- An example cannot drift from what its pack does: every step it shows is
  checked by the package's tests, and the catalogue shows exactly those
  steps. A new example without scenarios fails R7 and the build.
- Rule coverage (does each rule of an example appear in a scenario?) stays
  a review item; nothing checks it mechanically.
- A third-party package gets the same mechanism through
  `bounded/testing/example-scenarios`, and its catalogue is honest only if
  its tests run it.
- That route is untested from a packed `bounded`: this repository's tests
  run the runner from the workspace's source (bounded-example links
  `bounded` to `src/`), never a third party installing the tarball and
  running its scenarios. Testing it is Node-dist work, out of scope until
  the bundled bun binary; it is a limit.
- The guard-the-guardrails parity test
  (`src/test/guard-the-guardrails-init-defaults.test.ts`) is unchanged:
  scenarios check verdicts, not that the example's rules equal `bounded
  init`'s.
