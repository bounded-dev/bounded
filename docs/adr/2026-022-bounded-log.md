# 2026-022: The guard log is the Bounded log, kept in `.bounded/log.jsonl`

**Status:** accepted (the maintainer's decisions). Supersedes
[ADR 2026-008](2026-008-guard-log.md), restating the decision as it stands
today under the new names. Amends [ADR 2026-010](2026-010-project-configuration.md)
(the default log is `<root>/.bounded/log.jsonl`) and
[ADR 2026-013](2026-013-restructure.md) (A's first bullet: the decision log is
the Bounded log, not the guard log).

## Context

The log holds every decision Bounded makes: every event's decision, every
refusal a host adapter makes itself, and the packs' after-tool reports. It
was named the guard log (ADR 2026-013), which says it holds the guards'
verdicts only. In the maintainer's words, it is "not about the guard it's
literally about everything all the logging".

## Decision

### The rename

| Was | Is |
| --- | --- |
| the guard log | the Bounded log ("the log" where the context is clear) |
| `.bounded/guard-log.jsonl` | `.bounded/log.jsonl` |
| port `GuardLog` | `BoundedLog` |
| port `ProjectGuardLogs` | `ProjectBoundedLogs` |
| `FileSystemGuardLog` (`adapters/out/guard-log/`) | `FileSystemBoundedLog` (`adapters/out/bounded-log/`) |
| `FileSystemProjectGuardLogs` (`adapters/out/project-guard-logs/`) | `FileSystemProjectBoundedLogs` (`adapters/out/project-bounded-logs/`) |
| test double `InMemoryGuardLog` | `InMemoryBoundedLog` |
| `judge-event.guard-log.test-support.ts` (`guardLogConformance`, `GuardLogFixture`) | `judge-event.bounded-log.test-support.ts` (`boundedLogConformance`, `BoundedLogFixture`) |
| `open-project.project-guard-logs.test-support.ts` (`projectGuardLogsConformance`, `GuardLogsFixture`) | `open-project.project-bounded-logs.test-support.ts` (`projectBoundedLogsConformance`, `ProjectBoundedLogsFixture`) |
| `application/guard-log/judge-event/` | `application/bounded-log/judge-event/` |
| `openProject`'s option `guardLog` | `boundedLog` |
| the open-project handler's `guardLogs` | `boundedLogs` |
| `docs/guard-log.md` | `docs/bounded-log.md` |
| redirect "Make the guard log writable; until decisions can be recorded, every action is refused" | "Make the Bounded log writable; until decisions can be recorded, every action is refused" |
| `bounded init`'s `.bounded/**` rule's why "Bounded's own state and guard log" | "Bounded's own state and log" |

Technology qualifiers stay on the classes (ADR 2026-017). The folders follow
the ports' names (`adapters/out/<port>/`, ADR 2026-017). "The guards allowed
this, but the decision could not be recorded" is unchanged: it is about the
guards. `Decision`, `DecisionId`, `DecisionIds`, `Clock` and the judge-event
feature keep their names.

- **The file is `.bounded/log.jsonl`.** `FileSystemProjectBoundedLogs` gives
  each project `<root>/.bounded/log.jsonl`, `openProject`'s default.
- **An existing `.bounded/guard-log.jsonl` is left alone.** Nothing reads,
  writes, moves or deletes it; new decisions go to `.bounded/log.jsonl`.
- **The record's shape is unchanged.** No field names the guard, so stored
  data keeps its shape (as ADR 2026-013 kept it).

### The decision as it stands

- **Every decision is recorded through `BoundedLog`** by the judge-event
  feature (ADR 2026-008): `JudgeEventHandler` takes the composition and the
  out ports `BoundedLog`, `Clock` and `DecisionIds`, runs the pure,
  synchronous `decideEvent`, then awaits `BoundedLog.record(decision)`.
- **The judge parses first** (ADR 2026-013, B3): the judge parses a raw event
  with `JudgeEventCommand.parse`, and `execute` takes the parsed command. Input
  that is not a command is refused by `judge` without throwing and recorded
  as an `invalid` decision.
- **Shell commands are read before judging** (ADR 2026-020): judge-event
  reads each execute effect's command through the `ShellCommandReader` port
  before the guards run.
- **A decision is plain data** (ADR 2026-008): time, event kind, role, tool,
  the effects described and the verdict; a refusal names the refusing pack and
  effect.
- **The log is asynchronous, and bounded in time** (ADR 2026-008): recording
  must finish within two seconds by default, because a host hook waits.
- **Fail closed** (ADR 2026-008): if recording rejects, throws, takes too long
  or the clock or ids fail, a refusal stays a refusal with its reason extended,
  and an allow becomes a refusal. The handler never throws.
- **The log never contradicts what was enforced** (ADR 2026-008): a record
  that lands after the bound is followed, once it settles, by a line with the
  same id, the enforced refusal and the note "not recorded in time; enforced:
  refuse"; readers take the later line for an id. Host adapters let the event
  loop drain after answering.
- **Bounded and private** (ADR 2026-008): text fields are shortened past
  4,096 code points; the file log creates its file with mode 0600, makes an
  existing one so, and appends each record as one complete line; readers skip
  a line that does not parse. Installers ignore `.bounded/` in version
  control. Redaction is a later hook.
- **Strict bounds** (ADR 2026-008): a bound that is not a finite number of
  milliseconds above zero stops the handler from being built.
- **Value-object time and ids** (ADR 2026-017): `Clock.now()` gives a
  `DecisionTime` and `DecisionIds.next()` a `DecisionId`, each parsed again
  when a decision is recorded.
- **Adapters** (ADR 2026-017): `FileSystemBoundedLog`, `SystemClock` and
  `RandomDecisionIds`, each running its port's conformance suite. The
  in-memory log, `InMemoryBoundedLog`, is a test double in test support, not
  an adapter.
- **Deviations from the example** (ADR 2026-008): the handler takes the
  composition beside its out ports; the command's input is the event's wire
  form, checked by `Event.parse`; the bound is a timer in the application
  layer.

### Protection

Both files are protected by the project's own `.bounded/**` rule, which
`bounded init` writes into `bounded.config.ts` and the path gate judges like
any rule. Nothing in the code names either file: a rule for one file would be
a special case beside the one plug-in mechanism.

### Release

This rename ships in `bounded` 3.3.0, beside the protected-paths rename
(ADR 2026-021). It breaks what the published 3.2.0 exposes:
`bounded/application`'s types `GuardLog` and `ProjectGuardLogs`,
`bounded/open-project`'s `guardLog` option, and the internal
`bounded/adapters` classes `FileSystemGuardLog` and
`FileSystemProjectGuardLogs`, with no compatibility aliases. A project's
`bounded.config.ts` imports none of these names.

## Why

A name says what the thing holds. The log holds every decision Bounded makes, so it is
the Bounded log, and in `.bounded/` it is simply the log. Leaving the old file
alone keeps a project's history where it was without code that knows about a
file Bounded no longer writes.

## Consequences

- A project's history may sit in two files: `.bounded/guard-log.jsonl` through
  3.2.0, `.bounded/log.jsonl` from 3.3.0.
- A hand-written rule naming only `.bounded/guard-log.jsonl` (rather than
  `.bounded/**`) does not protect `.bounded/log.jsonl`; the project must change
  it.
- A project initialised earlier keeps its rule's why "Bounded's own state and
  guard log": its `bounded.config.ts` is its own, and nothing rewrites it.
- A TypeScript host that passes `guardLog` stops compiling. An untyped host
  that still passes `guardLog` has it ignored: its decisions are recorded in
  `.bounded/log.jsonl`, so enforcement does not fail open, but a host that used
  it to send decisions to its own (say, remote) store silently loses that store
  until it passes `boundedLog`.
