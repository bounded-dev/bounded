# 2026-013: The restructure: names that say what they hold, contracts everywhere, and rules that keep them

**Status:** accepted. Built in steps: A (renames), B (contracts and their
rules), B2 and B3 (effect guards and shape validation, recorded below when
they land), C (the tool lifecycle, recorded below when it lands).

## Decision

### A. Renames, with no change of behaviour

- **The decision log is the guard log** (ADR 2026-008 renamed): `GuardLog`,
  `ProjectGuardLogs` and their adapters, `application/guard-log/judge-event/`,
  the `guardLog` option, `docs/guard-log.md`. A guard log holds decisions,
  so `Decision`, `DecisionId`, `DecisionIds` keep their names. The one
  agent-visible text that changed is the guard log's own redirect ("Make the
  guard log writable; …").
- **`application/projects` is `application/project-config`**: the area only
  loads `bounded.config.ts` and opens a judge from it.
- **The library's composition root is `src/composition-root/`** (was
  `src/pack/`, which read like a pack); the export path `bounded/open-project`
  is kept.
- **Names say what they hold:** `selectedPackIds`, `availablePacks` and
  `selectedPacks`, `fromPackId`, `refusedBy.packId`,
  `Config.selectedPacks` and `projectPack`, `projectRoot`, `configSource`
  and `guardLogs`, `hostToolName`, `ToolUse.toolKind` and
  `ToolResult.toolKind` (the wire key stays `tool`), `FileChange`,
  `BasePack`/`BasePoint`/`BaseDeclaration` (not `Any…`, which read as
  TypeScript's `any`), and in the hosts `projectRoot`, `ProjectJudgeForPi`
  and `LoadJudge`.
- **Kept, so stored data never changes shape:** the guard log's JSON lines
  (`RecordedVerdict.pack`, `Decision.host.tool`, the `tool` key) and the
  snapshot files (`rule`, `commit`).

### B. Contracts everywhere, as in the worked example

- Every domain concept is a contract, an implementation and a test, and a
  value object also has a laws test (`<name>.laws.test.ts`, where the shared
  value-object laws run). `guards/guard.contract.ts` is dissolved: the guard
  types and `LabelledGuard` are `dispatch.contract.ts`'s, `Judgement` and
  the `DecideEvent`/`DispatchEvent` types `dispatch-event.contract.ts`'s;
  `project-opening.contract.ts` folds into `core-pack.contract.ts`.
- **Each pack the package ships has a contract it is typed by.**
  `core-pack.contract.ts` names every point of `bounded/core` with its value
  type and when it runs (`CorePackPoints`, `CorePack`), and
  `export const corePack: CorePack = definePack(…)`, so the definition must
  match the contract at compile time; `path-gate.contract.ts` does the same
  for `bounded/path-gate` (`PathGatePoints`, `PathGate`). The points are a
  type alias, not an interface, so a pack's points stay a record of points
  as composition reads them.
- **Each feature's contract names every port it needs**, re-exporting under
  "Out ports" those it shares with another feature (the guard log, the clock,
  decision ids), and names its handler's options (`JudgeEventOptions`,
  `OpenProjectOptions`, `WatchShellOptions`). The judge-event in port
  declares `judge(raw)` and `refuse(refusal)` too, and the open-project
  handler holds a `JudgeEvent`, not the class.
- **Every out adapter is a class implementing a port**, in a file that
  exports nothing else (the state-home helpers moved to their own file),
  and every port tagged `@implementedBy` has a conformance suite every
  adapter of it runs (`ProjectPathKinds` gained one).
- **How a protected-path rule meets a path is the rule's own**:
  `matches`, `reaches`, `contains`, `unavoidable` and `filterable` are
  methods its contract declares; `matching.ts` is gone. The path gate's
  copy of the wire helpers is gone too: `sameWire` and `wireFormOf` are
  exported from `bounded/domain`.

### The rules, in `architecture.test.ts` (each tested on small fixtures)

- **R1** an out adapter implements a port an application contract declares,
  and its file exports nothing else.
- **R2** a port tagged `@implementedBy` has an adapter per technology named,
  a conformance suite beside the contract, and a test beside each adapter
  that runs it.
- **R3** in the domain (and a pack's `domain/` and `pack/`), every concept
  is a contract, an implementation and a test, plus a laws test for a value
  object; every contract has its implementation.
- **R3b** a pack the package ships is typed by the contract beside it.
- **R4** every feature has a contract, and its handler implements the in
  port from it.
- **Exemptions, each named in the test with its reason:** the shared kernel
  (`domain/shared/{result,read,text,wire}.ts`) and barrels; `ProjectDrift`'s
  missing conformance suite and `domain/drift/watched-paths.ts`, both
  removed by step C.

## Consequences

A reader finds every way a pack plugs into the core, or into the path gate,
in one file, and a definition that drifts from its contract does not
compile. New adapters, ports, features and concepts are held to the same
shape by the architecture test rather than by review alone.
