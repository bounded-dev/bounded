# 2026-010: A project's configuration, and opening a project for judging

**Status:** accepted; amended by [ADR 2026-013](2026-013-restructure.md):
the feature lives in `application/project-config`, and `openProject`'s
`ports` option (adapters for the selected packs' ports) replaces its
`drift` and `pathKinds` options; a selected pack's port not provided refuses
every event. Amended by
[ADR 2026-018](2026-018-selection-brings-in-dependencies.md): the project
depends on the listed packs, and the selection brings in every pack they
depend on. Amended by
[ADR 2026-020](2026-020-shell-command-reading.md): `openProject(root,
options)` requires `shellCommandReader`, prepared when the project opens,
with which the judge reads every shell command; an untyped caller that
omits it still gets a judge, which judges every command unread.

## Decision

- **`defineConfig({ packs, contributes })`** selects pack objects and adds the
  project's own contributions. It builds an implicit pack, `bounded/project`,
  whose `dependsOn` is the selected packs, so the compile-time rule "only to
  points of packs you depend on" holds for the project exactly as for a pack
  (the same `PackListRules`: a tuple of distinct packs with exact ids). The
  project pack is composed last-in-order with the selection; composition
  checks its contributions at run time like any pack's.
- **Genuine only.** A configuration is recorded in a module-private set;
  only one made by `defineConfig` in the same copy of `bounded` is accepted.
- **Loading is an async out port**, `ProjectConfigSource.load(root)`. The file
  system adapter imports `<root>/bounded.config.ts` (or `.js`, `.mjs`) with a
  dynamic import and refuses, with what to do: no configuration, more than
  one, a throw while loading, a default export `defineConfig` did not make.
  Only an out adapter may import code chosen at run time; the architecture
  test enforces it.
- **Opening a project** is an application feature, `project-config/open-project`:
  load, compose, and return a `ProjectJudge` over the judge-event feature.
  When the configuration cannot be used (cannot be loaded, or its packs
  cannot be composed), the judge refuses every event with the reason and
  records each refusal, so a broken configuration can never fail open.
  `ProjectJudge.judge` takes the event's wire form; an unreadable event is
  refused and recorded as `"invalid"`.
- **`openProject(projectRoot, options?)`** in the core's composition root
  (`src/composition-root/`)
  (`bounded/open-project`) is the composition root host adapters call. It
  wires the defaults: the file-system configuration source, a guard log
  at `<root>/.bounded/guard-log.jsonl`, the system clock.

- **Packs prepare when a project opens.** The core pack declares
  `onProjectOpen`: what a pack does once, before any event is judged, given
  the project (its root, and `kindOfPath` asking what is at a project path,
  through an application port with a file-system adapter) and its
  composition. `OpenProjectHandler` runs every contribution and waits for
  each, but for at most `prepareWithinMs` (5 seconds by default); one that
  fails or runs out of time does not stop the project opening, since the
  pack's own guards refuse what they cannot check. The path gate loads its
  shell parser this way (ADR 2026-009).
- **Opening never rejects.** `openProject` and `OpenProjectHandler.execute`
  catch every failure (an unusable `recordWithinMs`, a source that returns
  nothing, anything thrown) and return a judge that refuses every event,
  recording it when the project's log can be opened. Host adapters rely on
  always getting a judge.
- **A configuration runs code, so the core is frozen.** Every export of the
  public entry points, and every function's and class's prototype, is frozen
  when the entry point loads, so `bounded.config.ts` or a pack it imports
  cannot replace `Verdict.parse`, `Composition.compose` or a handler's
  methods. Gaps that remain: a configuration can still patch the runtime's
  own globals (`JSON`, `Promise`, `Object`), and it can import the core's
  files by path rather than through the package. So **`bounded.config.*` and
  every file it imports must be protected paths**: the path gate protects
  `bounded.config.*`; protecting the configuration's whole import closure is
  a recorded gap.
- **Strict loading.** The file must resolve inside the project (no link out of
  it). Each load imports the file as it is now (keyed by its modification
  time), so a changed configuration is read afresh without a restart.

## Deviations from the example

- The open-project feature reuses the judge-event feature's `GuardLog` and
  `Clock` ports rather than declaring identical copies: it composes that
  feature, and the ports must stay the same.
- The application handler constructs another feature's handler: opening a
  project is the composition of judging over a loaded configuration.
- `JudgeEventHandler` accepts `refuseEverything`, a refusal given to every
  event, so the broken-configuration judge records exactly like the real one.
