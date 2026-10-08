# 2026-017: Out adapters are grouped by the port they serve; test doubles are test support; Clock and DecisionIds give value objects

**Status:** accepted (the maintainer's decisions, in the reviews of the
adapter-naming plan and the final review), shipped in `bounded` 3.1.0 as a
deliberate breaking change in a minor release (see "Release"). Supersedes in part ADR 2026-013 (its R2 wording, and
the path gate's export paths in its drift and path-kinds bullets) and ADR
2026-012 (the bullet "Ports keep text where it is the store's key", as it
applies to `DecisionIds`).

## Decision

### Layout

- **One folder per out port.** An out adapter sits in
  `adapters/out/<port>/`, `<port>` the port interface's name in kebab case
  (`GuardLog` → `guard-log`, `ComposePacksCatalog` →
  `compose-packs-catalog`), in the core and in a shipped pack alike. The
  technology folders (`file-system/`, `in-memory/`, `system/`,
  `tree-sitter/`) are gone.
- **A file is named for the port, or for its class when the port has
  several.** A port with one production adapter keeps it in `<port>.ts`. A
  port with several names each file after its class in kebab case, so it
  ends in `-<port>`: today only `ProjectConfigSource`, with
  `file-system-project-config-source.ts` and
  `checked-project-config-source.ts`. Helpers with no adapter class sit
  beside their users (`load-failure.ts`, `config-as-module.ts`,
  `shell-parser/brace-expansion.ts`), and the path gate's
  `state-directory.ts` (`stateHomeFor`, `stateDirFor`) and
  `port-provisions.ts` at its `adapters/out/` root, as both the port
  provisions and the shell snapshots use the state directory.
- **Class names keep their technology qualifier** (`FileSystemGuardLog`,
  `SystemClock`, `TreeSitterShellParser`, …): the port interface owns the
  bare name, and both are public. No class is renamed.
- **The in-memory doubles are test support.** `InMemoryGuardLog`,
  `InMemoryPathKinds`, `InMemoryShellSnapshots` and `InMemoryWatchedFiles`
  had no importer outside tests. Each moves beside its port as
  `<feature>.in-memory-<port>.test-support.ts`, run through the port's suite
  by `<feature>.in-memory-<port>.test.ts`. None is published: the package's
  `files` globs keep test support out of the tarball. A published
  `testing/` export of them can come later; removing one after publishing
  could not be undone.
- **`InMemoryComposePacksCatalog` stays a production adapter**
  (`adapters/out/compose-packs-catalog/compose-packs-catalog.ts`): it is the
  only implementation of the port the public `ComposePacksHandler` runs on,
  and the packs it serves really are objects in memory.
- **`pathGatePortProvisions(stateHome?)`** replaces `pathGateFileSystem` and
  `pathGateTreeSitter`: the same four provisions (watched files, shell
  snapshots, path kinds, the shell parser), frozen. Every caller spread the
  two together. `pathGateInMemory`, which nothing used, is deleted.
- **Host apps keep their layout.** Apps have no layers and no rules of their
  own; only their call sites change.

### Export paths

- **Two adapter export paths replace the six technology ones:**
  `bounded/adapters` (`src/adapters/out/index.ts`) and
  `bounded/path-gate/adapters` (`src/packs/path-gate/adapters/out/index.ts`),
  each with the `{ bun, types, default }` conditions of ADR 2026-016, so
  `build-dist.ts` builds and declares them as it does every library export.
  Two, not one, so a host that does not select the path gate never loads
  tree-sitter.
- **They are internal.** The package's README says the adapter export
  paths serve the bundled hosts and the `bounded` command and may change in
  any release.

### Release

This change breaks what `bounded` 3.0.0 published. It removes the six
adapter export paths (`bounded/adapters/{file-system,in-memory,system}` and
`bounded/path-gate/adapters/{file-system,in-memory,tree-sitter}`), the
in-memory doubles they exported (`InMemoryGuardLog`, `InMemoryPathKinds`,
`InMemoryShellSnapshots`, `InMemoryWatchedFiles`) and `pathGateInMemory`,
and it retypes `Clock.now()` and `DecisionIds.next()`. All were published
in 3.0.0. The maintainer deliberately ships that break as a minor release,
3.1.0, with no compatibility aliases: 3.0.0 had been published about an hour
earlier and had no users.

### Ports

- **`Clock.now()` gives a `DecisionTime` and `DecisionIds.next()` a
  `DecisionId`,** as plain values, not results. The question behind
  `ids.ts`: it produced a fresh random UUID per call as text. The value
  object already existed (`domain/decisions/decision-id.ts`); the port now
  returns it, so no new value object is needed. `SystemClock` and
  `RandomDecisionIds` build theirs with `parse` and throw on the failure
  that cannot happen.
- **Throwing fails closed.** Every call sits inside the handlers' recording
  `try`: in `JudgeEventHandler`, both the clock and the ids run inside the
  decision's `build`, which `record` calls inside its `try`, and the
  follow-up after a late record catches around the clock; in
  `ProjectLifecycleHandler`, `record`'s `try` covers both. A throw is a
  failure to record, which refuses (judge-event) or is swallowed
  (lifecycle), exactly as a throwing clock was.
- **The handlers still parse at run time,** with the same messages ("the
  clock gave '…', not an ISO 8601 time"; "the decision ids gave an invalid
  id: …"). A host's clock and ids are unchecked at run time, so `parse`
  takes either a made instance (it re-parses the instance's wire form) or
  the wire text: a host clock that still gives an ISO 8601 string keeps
  working, a deliberate leniency with the same validation. A look-alike not
  made by the class is refused. `ProjectLifecycleHandler` still skips a
  record without a word when the clock's value does not parse.
- **`openProject` gives `RandomDecisionIds`** through a new
  `OpenProjectOptions.ids` of the open-project feature, which
  `OpenProjectHandler` passes to both judges (the composed one and the one
  that refuses everything) and to the lifecycle handler. The hosts'
  `openProject` options do not gain it.
- **One shared default, `defaultDecisionIds`,** exported from
  `judge-event.handler.ts` beside `nextDecisionId`, replaces the two inline
  `{ next: () => crypto.randomUUID() }` defaults. It is only the default for
  code that builds a handler directly; `openProject` gives the adapter. It
  is kept rather than making `ids` required, which would change about thirty
  handler constructions in tests, the docs' example and hosts that build
  handlers directly.

### Rules (`architecture.test.ts`, `architecture.rules.test-support.ts`)

- **R1** (`adapterContractViolations`, unchanged, and the new
  `adapterPlacementViolations`): every exported class under `adapters/out/`
  implements a port an application contract declares, in a file that
  exports nothing else; it sits in `adapters/out/<port>/` for a port it
  implements, in `<port>.ts` when it is the only adapter-class file in that
  folder and in `<class>.ts` (kebab case) otherwise. Files that hold no
  adapter class are not constrained.
- **R2** (`implementedByViolations`, rewritten): `@implementedBy` names
  adapter classes, not technologies, as a technology tag has nothing left to
  check. Each named class is under `adapters/out/<port>/` and implements the
  port; every adapter class implementing a port of an application contract
  is named in that port's tag; the port's suite is exactly
  `<feature>.<name>.test-support.ts` beside the contract, `<name>` the
  port's kebab name without a leading `<feature>-` (so a double is never
  taken for the suite), and a test beside each named class runs it. Four
  suites were renamed to fit (`judge-event.decision-ids`,
  `open-project.project-config-source`, `open-project.project-guard-logs`,
  `watch-shell.shell-snapshots`). `ComposePacksCatalog` gained a tag, and
  `CheckedProjectConfigSource` a conformance run over the file-system
  source it wraps.
- **R2, doubles** (the new `testDoubleViolations`, no exemption): a
  `*.in-memory-<name>.test-support.ts` sits in an application feature's
  directory, and a test there imports it and the port's suite. No
  production file (under `contexts/*/src` or `apps/*/src`, not a test, test
  support or fixture) imports a `*.test-support.ts`, by relative path or
  through a package export path resolved to its target. The host-installer
  conformance suite stays published through its `exports` entry
  (`bounded/testing/host-installer-conformance`), which the ban does not
  touch, and only the apps' tests import it.
- **A shipped pack's adapters** are one layer: any file under
  `packs/<name>/adapters/out/` may import its pack's domain, application
  and out adapters (the port provisions and the shell snapshots share the
  state directory), never another pack's. The limits on I/O and libraries
  are unchanged.

## Why

The maintainer: grouping adapters by technology is confusing;
`system/guard-log/clock.ts` and `ids.ts` say nothing, and "ids" means
nothing where a value object was expected; `system/` means nothing either.
Adapters should be grouped by the thing they serve and named as concisely as
possible yet exactly. A port typically has one production adapter, so by
default the technology is left out of the folder and the file; it appears
only where a port really has more than one. In-memory adapters that only
tests use are test doubles, and belong with test support. Ports that give
value objects say what they give; the run-time parse stays because a host
supplies them.

A folder named mechanically after the port can be checked by the
architecture test, and so can the suite's name and the tag's classes.

## Consequences

- A second production adapter for a port renames the first file to its
  class's name, as R1 then requires.
- A published `testing/` export of the doubles can come later, through
  `exports`; production code still may not import it.
- Code built against 3.0.0's adapter export paths, doubles or string-typed
  clock and ids would have to move to `bounded/adapters` and
  `bounded/path-gate/adapters`, the doubles' test support and the value
  objects; 3.0.0 had no users when 3.1.0 replaced it (see "Release").
- The older ADRs stay as written; this record says what of them it
  replaces.
