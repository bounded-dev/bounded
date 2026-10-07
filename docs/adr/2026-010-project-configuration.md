# 2026-010: A project's configuration, and opening a project for judging

**Status:** accepted.

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
- **Opening a project** is an application feature, `projects/open-project`:
  load, compose, and return a `ProjectJudge` over the judge-event feature.
  When the configuration cannot be used (cannot be loaded, or its packs
  cannot be composed), the judge refuses every event with the reason and
  records each refusal, so a broken configuration can never fail open.
  `ProjectJudge.judge` takes the event's wire form; an unreadable event is
  refused and recorded as `"invalid"`.
- **`openProject(root, options?)`** in the core's pack layer
  (`bounded/open-project`) is the composition root host adapters call. It
  wires the defaults: the file-system configuration source, a decision log
  at `<root>/.bounded/guard-log.jsonl`, the system clock.

## Deviations from the example

- The open-project feature reuses the judge-event feature's `DecisionLog` and
  `Clock` ports rather than declaring identical copies: it composes that
  feature, and the ports must stay the same.
- The application handler constructs another feature's handler: opening a
  project is the composition of judging over a loaded configuration.
- `JudgeEventHandler` accepts `refuseEverything`, a refusal given to every
  event, so the broken-configuration judge records exactly like the real one.
