# 2026-013: The restructure: names that say what they hold, contracts everywhere, and rules that keep them

**Status:** accepted. Built in steps: A (renames), B (contracts and their
rules), B2 (effect guards), B3 (shape validation, in two parts), C (the
tool lifecycle, recorded below when it lands).

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

### B2. Effect guards: one point group, routed by lookup

- **The kind-to-type map exists once**: `EffectByKind` in
  `effect.contract.ts` maps each effect kind to its type, and `KindsMatch`
  refuses an entry whose `kind` differs from its key. `EffectKind` and
  `Effect` are derived from it.
- **A pack may group points, one level deep**: `pointGroup({ … })` declares
  member points under one key; a member's id is
  `<pack id>.<group key>.<member key>` and its owner is the pack, so the
  ownership rules are unchanged. A group is not a point: contributing to it
  does not compile. Composition walks groups one level and refuses, for
  untyped data, a group in a group, a member key that is not camelCase and a
  member that is not a genuine declaration.
- **The core's seven effect points are one group**, `effectGuards`, typed by
  `EffectGuardPoints` (one point per `EffectKind`): `readGuards` became
  `effectGuards.read`, and so on; point ids changed with them
  (`bounded/core.effectGuards.read`), which composition refusals show.
  Amends ADR 2026-007.
- **Dispatch finds an effect's guards by its kind**:
  `corePack.points.effectGuards[kind]` with a generic kind gives that kind's
  point, so each guard is called with the effect at its kind's type, without
  a switch. A labelled guard is a thunk (`run`), so neither an untyped guard
  nor an argument list remains.
- **R5**: `dispatch.ts`, `dispatch-event.ts` and `effect.contract.ts` contain
  no type assertion (`as`, `<T>x`, `!`); `core-pack.ts` contains exactly one,
  in `functionOf`, because a contributed function's signature cannot be
  checked at run time (dispatch re-checks every verdict, ADR 2026-007).
  `define` in `pack.ts` keeps its documented `as never`: it builds the mapped
  pack type from run-time keys.

### B3. Shape checks live in the class that owns the shape

- **The binding rule** (AGENTS.md): every "is this really an X" check is in
  the `parse` or factory of the class that owns X; functions and handlers
  take instances and apply only business and combination rules; untyped
  input is parsed once, at a boundary. Moved checks keep their messages.
- **Packs, points, declarations, contributions and configurations are
  classes** with private constructors, frozen when made; `definePack`,
  `point`, `pointGroup`, `contribution` and `defineConfig` are their
  factories, and stay total, so a JavaScript configuration still reaches
  composition and gets today's message. Genuineness is `instanceof` in the
  owning class: the module WeakSet, `isGenuine`, `isComposition`,
  `isConfig` and `composeConfig` are gone (`Config.parse(raw)`,
  `config.compose()`, `parsePack(raw)` replace them).
- **A pack names its own problem**: what composition used to check about a
  pack's shape (dependencies, point keys, points made by `point`, a check,
  own values a list, contributions made by `contribution`, groups one level
  deep) is the pack's `problem`, worked out when it is made; composition
  refuses a selected pack that has one, with the same message. A point
  parses a value with its own check (`point.parseValue`).
- **`AvailablePacks` and `SelectedPacks`** parse the two lists composition
  is given (a list; each pack made by `definePack`; valid, distinct ids; a
  pack selected once). They hold pack objects, which have no wire form, so
  they are parsed collections, not value objects with laws.
  `Composition.compose` parses both, then applies only the combination
  rules: a selected pack is available, has no problem, and its dependencies
  are selected; contributions go only to dependencies' points.
- **Dispatch takes instances**: `decideEvent(composition, event)` and
  `dispatch(guards, event)` no longer re-parse the event; hosts parse a raw
  event once, in the judge. A composition is nominal (every branded type
  carries a module-private `unique symbol` brand, ADR 2026-012), so a typed
  caller cannot pass a look-alike, however complete; an untyped one (a
  JavaScript configuration, a cast) is refused at run time by
  `Composition.parse`, the `instanceof` check in the owning class, which
  `decideEvent` asks first. A
  guard that is not a function still refuses by name; a guard's return value
  is still parsed by `Verdict.parse`, and the promise check stays beside it
  in dispatch, since its message names the guard.
- **Ports' answers are parsed where they arrive.** The pack catalog answers
  `Result<AvailablePacks>` (the in-memory catalog parses its packs), so
  compose-packs only maps ids to packs. A host's configuration source is
  wrapped in `CheckedProjectConfigSource` (`bounded/adapters/system`), which
  turns a throw, an answer that is not a result, a refusal without a reason
  or a value `defineConfig` did not make into today's messages; the
  open-project handler trusts its port. The judge parses a raw event with
  `JudgeEventCommand.parse`, and `execute` trusts its command.
- **New value objects**: `AdapterRefusal` (a refusal a host adapter made
  itself, read leniently: text coerced, a missing tool name 'unknown');
  `DecisionTime` (the clock's answer, ISO 8601 in UTC); `Snapshot` (the
  watched files before a shell command: its form is checked by
  `Snapshot.parse(raw, ruleCount)` with today's messages, while whether its
  copies and committed files match their hashes stays with the feature that
  restores from it).
- **R6**: in domain and application code a shape check (`Array.isArray`,
  `typeof … === "object"`, `instanceof` of anything but `Error`) appears
  only where a shape is owned, or in a file named in the test with its
  reason (dispatch's promise check).

### C. The core keeps the mechanism; packs bring lifecycle checks and ports

- **Lifecycle points.** The core pack gains `beforeTool` (asynchronous
  checks after the guards allow a tool call, before it runs; a refusal
  replaces the allow) and `afterTool` (asynchronous checks after it ran;
  every one runs, each reports an `AfterToolReport`: a message for the
  agent and a record the core writes to the guard log, naming the
  contributing pack). Their value types, `BeforeTool`, `AfterTool` and
  `LifecycleContext` (the composition and the project's ports), are in the
  core pack's contract. Function-valued contributions may be asynchronous
  here: the deviation ADR 2026-002/003 allow for function values, extended
  to promises. The application feature `lifecycle/project-lifecycle` runs
  them; a check that throws or answers out of form fails closed, named by
  its pack. The core records after-tool reports, so a pack never touches the
  guard log.
- **Ports.** A pack declares the adapters it needs in its `ports` section
  (`portKeysFor(packId)<Adapter>("name")`), the last section of
  `definePack` after `id`, `dependsOn`, `points` and `contributes`. A host's
  composition root supplies them with `openProject(root, { ports: [Ports.provide(key, root => adapter)] })`:
  `provide` ties the adapter to the key's type, keys meet by
  `<owner>#<name>`, and an adapter opens lazily, at most once per project.
  When a project opens, every port the selected packs need
  (`composition.requiredPorts()`) must be provided, or the judge refuses
  every event naming the pack, the port and the fix. A pack declares only
  its own ports, checked at compile time and when the pack is made.
- A third-party pack with ports works only on hosts whose composition root
  provides them; the refusal names exactly what to provide.
- **Drift is the path gate's.** The core's `watchedPaths` point, its
  `drift/watch-shell` feature, its drift adapters and `ProjectDrift` are
  gone; `ProjectJudge.afterTool` gives `{ message }`. The path gate is a
  small hexagon: `domain/` (its rules, watched paths, watching, snapshots),
  `application/watch-shell/` (the feature, now returning what to record
  instead of writing the guard log, and its two lifecycle checks), and
  `adapters/out/{file-system,in-memory}/` with their own export paths
  (`bounded/path-gate/adapters/file-system`, `…/in-memory`). It watches
  every `protectedPaths` rule that denies a write, as before; it declares the
  ports `watchedFiles` and `shellSnapshots`, which both hosts provide with
  `pathGateFileSystem()`. State paths are unchanged. A configuration that
  contributed to `watchedPaths` directly no longer compiles: protect the
  files with a `protectedPaths` rule that denies writes.
- Inside a shipped pack (architecture test): `domain/` imports only itself,
  `application/` its domain and application, the root files their domain,
  application and root, and only `adapters/out/<tech>/` may do I/O.

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
- **R5** the routing files assert no types (above).
- **R6** shape checks live where the shape is owned (above).
- **Brands** stay in their contracts: no barrel exports one, or re-exports a
  contract wholesale.
- **These rules guard against mistakes; they do not prove the property.**
  Each is a syntax check over one file at a time: R3b sees a pack defined
  by calling `definePack` in an exported const, not one built through a
  helper or re-exported from elsewhere; R5 counts assertions and silencing
  directives in the routing files themselves, not in helpers they import;
  R6 sees `Array.isArray`, `typeof … === "object"` and `instanceof`, not
  checks written through helpers (`isRecord`, `own`, `Object.hasOwn`, `in`,
  `typeof` of a primitive), and judges ownership by file, not by the class
  or function the check sits in. The compiler, the brands and review cover
  the rest.
- **Exemptions, each named in the test with its reason:** the shared kernel
  (`domain/shared/{result,read,text,wire}.ts`) and barrels.

## Consequences

A reader finds every way a pack plugs into the core, or into the path gate,
in one file, and a definition that drifts from its contract does not
compile. New adapters, ports, features and concepts are held to the same
shape by the architecture test rather than by review alone.
