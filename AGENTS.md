# Agent and contributor instructions: bounded-core

This file is binding for every agent and every human contributor. It is
written for an open-source audience: keep everything in this repository
(docs, comments, commit messages, ADRs) free of credentials, personal paths
and context that only makes sense to one person or machine. Machine-specific
notes belong in an untracked local file.

`docs/spec.md` is the product requirement. `README.md` explains the design.
Decisions are recorded in `docs/adr/` (index in `docs/adr/README.md`).

## Tooling

Bun is the runtime, package manager and test runner.

| Command | What it does |
| --- | --- |
| `bun install` | Install the workspace's pinned dependencies |
| `bun run check` | The whole check: `typecheck`, `lint`, `test` |
| `bun run typecheck` | `tsc` over every workspace, strict |
| `bun run lint` | Biome's linter |
| `bun run test` | `bun test`: unit, law, conformance, architecture and compile-time tests |

`bun run check` must be green before any commit that is not a red commit.

## The development lifecycle

Every non-trivial change follows [the development lifecycle](docs/development-workflow.md)
(ADR 2026-001): plan, plan review, red commit, build, final review, report.

- **Superseded tests are recorded.** A design change that replaces a test an
  earlier red commit owns records it in `superseded-tests.json` (successor
  and reason), in the red commit of that change.
- **Red first, never weakened.** Commit the failing tests alone before
  implementing: test files, `*.test-support.ts` conformance suites and
  fixtures only. Before review, run
  `bun scripts/workflow/red-first-check.ts <red-commit> [<branch>]`: it proves
  the red commit touched only tests, that its tests failed at that commit,
  and that none was later deleted, skipped, emptied or stripped of assertions,
  and each still runs and passes at the head.
- **Independent review.** A reviewer who did not write the change reviews the
  plan before tests and the final diff before merge, with ranked findings,
  repros and a verdict.
- **Merge with `--no-ff`**, never squash: the red commit is the evidence.
- Working files (plans, diffs, review replies) live in `.agent-state/`,
  which is gitignored. Never commit runtime state.

## Layout

```
contexts/
  core/          bounded             the mechanism: packs and composition (slice 1), events, verdicts and dispatch (slice 2)
    src/packs/path-gate/              the path gate (slice 3): a pack shipped in bounded, exported as bounded/path-gate
apps/
  claude-code/   bounded-claude-code the Claude Code host adapter (docs/adapter-claude-code.md)
  pi/            bounded-pi          the pi host adapter (docs/adapter-pi.md)
architecture.test.ts                 the layer and dependency rules, as a test
compile-time.test.ts                 proves an undeclared contribution does not compile
docs/adr/                            decisions, including every deviation from the layout below
scripts/workflow/                    the lifecycle's two scripts
```

Each context is a workspace package with this source layout, adapted from the
Bounded harness's hexagonal worked example:

```
src/
  domain/                 concepts and rules; no I/O, no library but zod
    shared/result.ts      Result<T, E>: every expected failure
    <area>/<concept>.contract.ts   interface <Name> + <Name>Factory (types only)
    <area>/<concept>.ts            class <Name>Impl (private constructor), then
                                   export type <Name> = Contract.<Name>;
                                   export const <Name>: Contract.<Name>Factory = <Name>Impl;
    index.ts              the domain barrel
  application/            features; no I/O, no library but zod
    <area>/<feature>/<feature>.contract.ts   wire Input, Command, in port, out ports
    <area>/<feature>/<feature>.command.ts    Input -> Command through value objects
    <area>/<feature>/<feature>.handler.ts    the in port's implementation
    <area>/<feature>/<feature>.<port>.test-support.ts  the port's conformance suite
    index.ts              the application barrel
  adapters/in/<tech>/     driving adapters: depend on in ports, never handlers
  adapters/out/<tech>/    driven adapters: implement out ports; each runs its port's conformance suite
  composition-root/       the context's composition root: openProject, which host adapters call (ADR 2026-010)
  packs/<name>/           a pack shipped in the context's package, such as path-gate/ (ADR 2026-009)
```

Rules, enforced by `architecture.test.ts` unless stated:

- **Dependencies point inwards:** domain <- application <- adapters <- composition-root;
  a shipped pack (`packs/<name>/`) depends on the domain only.
  Adapters never import other adapters' technologies.
- **Domain and application do no I/O** and import no library but zod.
- **Within a context, layers import each other through the package's own
  export paths** (`bounded/domain`), domain files by relative path.
- **Apps** (`apps/<name>/src`) are programs built on the contexts, such as
  host adapters. They may do I/O and use libraries, reach a context only
  through its export paths and declared dependencies, and never import
  another app.
- **A context imports another context only when its `package.json` declares
  it as a dependency**, and only through that package's export paths. The
  core depends on nothing and never imports a pack.
- **Apps** (`apps/*`) host contexts: no layers, no rules of their own. An app
  imports its own files by relative path, a context only through its export
  paths and only when its `package.json` declares it, and never another app.
- **Value objects are classes, as in the worked example (ADR 2026-012).**
  The contract declares a branded interface (`readonly __brand`, the value,
  `equals`, `toJSON`) and a factory (`parse(raw: unknown): Result<X>`); the
  class has a private constructor and freezes itself; `toJSON` gives the
  wire form, so serialised data never changes shape. Never a branded
  primitive (`string & { … }`) nor a plain object with a type-only brand:
  the architecture test refuses both. Entities are built with `new` from
  valid value objects.
- **Every out port has a conformance suite** (`*.test-support.ts`) run by a
  test beside every adapter that implements it.
- **Contracts everywhere (ADR 2026-013).** R1: every out adapter is a class
  implementing a port an application contract declares, in a file that
  exports nothing else. R2: every port tagged `@implementedBy` has an
  adapter per technology named and a conformance suite each runs. R3: every
  domain concept (in `domain/`, and a pack's `domain/` and `pack/`) is
  `<name>.contract.ts`, `<name>.ts` and `<name>.test.ts`, plus
  `<name>.laws.test.ts` for a value object. R3b: every pack a package ships
  is typed by the contract beside it. R4: every feature has
  `<feature>.contract.ts`, naming every port it uses, and its handler
  implements the in port from it. R5: the files that route events
  (`dispatch.ts`, `dispatch-event.ts`, `effect.contract.ts`) assert no types
  (`as`, `<T>x`, `!`), and `core-pack.ts` has exactly one, in `functionOf`.
  Exempt, each named in the test with its
  reason: barrels, the shared kernel (`domain/shared/{result,read,text,wire}.ts`)
  and, until step C, `ProjectDrift` and `domain/drift/watched-paths.ts`.
- **Shape checks live in the class that owns the shape (ADR 2026-013).**
  Every check of the form "is this really an X, with the right fields" is in
  the `parse` (or factory) of the class that owns X, the only way to get an
  instance; an `instanceof` of a domain class appears only there. Functions
  and handlers take valid instances and apply business and combination rules
  only (a pack contributes only to its dependencies' points; the first
  refusal wins). Untyped input is parsed once, at a boundary: a command's
  `parse`, an adapter (config load, a port's output, a host payload), a
  point's check, or the return value of contributed code (a guard's verdict,
  a point check's result). A moved check keeps its message.
- **A shipped pack is an ordinary pack** (ADR 2026-009): its code under
  `src/packs/<name>/` imports only the package's `domain` export path, its
  own directory and libraries the package declares, and does no I/O; nothing
  outside that directory imports it but tests under the composition root
  (`src/composition-root/`), so the core never depends on a pack.
- **Pack ids root at their own package**: every `packIdsFor(...)` call in a
  workspace's source names that workspace's package.json `name`.
- Generic types, function-valued contributions and synchronous reads are
  allowed where the extension mechanism needs them; each such deviation from
  the example is recorded in an ADR (ADRs 2026-002 and 2026-003).

## The extension model — binding

- **The core owns mechanism, never content.** It defines packs, typed
  extension points, contributions, composition, data contributions, the
  host-neutral event vocabulary (a tool use is a list of effects), verdicts
  and dispatch. It holds no opinion about any application and names no
  programming language, framework, tool or agent host. The core's own pack,
  `bounded/core`, is the only place it declares extension points: one guards
  point per event kind, and a group with one point per effect kind (ADR
  2026-007, ADR 2026-013). Gates contribute
  guards there and never handle one effect versus many.
- **Packs own content.** A pack declares its own extension points and
  gives values to its own points and contributes to points of packs it lists
  in `dependsOn` (pack objects, so imports are the dependency graph).
  Contributing across an undeclared dependency does not compile and is
  refused at composition if it is built from untyped data.
- **Composition is per project.** Only selected packs take part; a pack that
  is not selected leaves no trace. Every refusal names the pack, the extension
  point and the fix.
- **Fail closed.** A missing, unreadable or malformed input is a refusal with
  an actionable message, never "contributes nothing".
- **Strict typing (ADRs 2026-003, 2026-004).** Anything not explicitly wired
  fails to compile: a pack contributes only to points of packs directly in
  its `dependsOn` tuple (each with an exact id from `packIdsFor`), with
  values of exactly the point's type, never containing `any`; points are declared only
  inside their own pack under camelCase keys; reads are typed by the point
  object.
  Composition repeats every rule at run time for untyped data. A change that
  loosens a rule, or adds one, comes with a rejected fixture line stating
  its reason (`contexts/core/test/fixtures/compile-time/`) and a run-time
  refusal test.
- **Every decision is recorded (ADR 2026-008).** Hosts judge events through
  the judge-event feature, which records each decision; a decision that
  cannot be recorded within the bound is refused, never allowed.
- **The project is a pack too (ADR 2026-010).** `defineConfig` turns a
  project's contributions into the pack `bounded/project`, which depends on
  every selected pack; a project never contributes to an unselected pack's
  point. A configuration that cannot be used makes every event refused.
- **Shell commands cannot change watched files (ADR 2026-011).** Hosts call
  `judge` before a tool call and `afterTool` after it, passing the call id;
  changes to watched files are undone and reported.
- If a change needs the core to learn a technology's name or an opinion, it is
  in the wrong place: put it in a pack and give the core a mechanism.

## Working rules

- **Names are extremely explicit and aligned exactly with what they
  represent.** (Binding, in the maintainer's words.) A variable, field,
  parameter, file, folder or feature is named for exactly what it holds or
  does: `selectedPackIds`, not `selected`, for a list of pack ids;
  `project-config`, not `projects`, for loading `bounded.config.ts`. A
  rename that makes a name more exact is always welcome.

- Durable guidance lives in this file, the README or an ADR, not in any
  agent's private memory.
- Never push, publish or open pull requests unless a maintainer asks.
