# 2026-008: Every decision is recorded, and an unrecorded decision fails closed

**Status:** accepted.

## Decision

- **An application feature.** `judging/judge-event` in the example's shape:
  `JudgeEventCommand.parse` checks the event (`Event.parse`); the
  `JudgeEvent` in port returns the verdict; `JudgeEventHandler` takes the
  composition and two out ports, `DecisionLog` and `Clock`. It runs the pure,
  synchronous `decideEvent`, then awaits `DecisionLog.record(decision)`.
- **A decision is plain data**: time (ISO 8601, UTC), event kind, role, tool,
  the effects described, and the verdict; a refusal also names the refusing
  pack and effect. `decideEvent` returns a `Judgement` (verdict and who
  refused) so the decision does not parse its own message.
- **The log is asynchronous**, so it can later be a remote service; recording
  must finish within two seconds by default, because a host hook waits for
  the answer and an unbounded wait would hang the agent.
- **Fail closed.** If recording rejects, throws, takes too long, or the clock
  fails, a refusal stays a refusal with its reason extended ("(this decision
  could not be recorded: …)"), and an allow becomes a refusal saying the
  decision could not be recorded. The handler never throws.
- **The log never contradicts what was enforced.** Every decision has an id.
  When a record lands after the bound, the handler appends, once it has
  settled, a line with the same id, the enforced verdict and the note "not
  recorded in time; enforced: refuse" (whether the late record landed or
  failed; none if it never settles); readers take the later line for an id.
  Host adapters must let the event loop drain after answering (no
  `process.exit` right after the verdict), so the late line is not lost.
  Ids come from a `DecisionIds` port, like the clock.
- **Bounded and private.** Text fields are shortened past 4,096 characters.
  Shortening counts code points, never splitting a character. The file log
  creates its file with mode 0600, makes an existing one so, and writes each record in one
  append of one complete line; readers skip a line that does not parse.
  Installers ignore `.bounded/` in version control. Redaction is left as a
  later hook.
- **Strict inputs.** The clock must give an ISO 8601 time, or recording has
  failed; input that is not a command is refused without throwing and is not
  recorded; a bound that is not a finite number of milliseconds above zero
  stops the handler from being built.
- **Adapters.** An in-memory log, a JSON-lines file log (append-only, one
  object per line, creating its folders; the composition root picks the
  file) and the system clock, each running its port's conformance suite.

## Deviations from the example

- The handler takes the composition as a constructor argument beside its out
  ports: the composition is a domain object built once per project, not I/O.
- The command's input is the event's wire form, checked by `Event.parse`,
  not a zod schema of strings.
- The bound uses a timer in the application layer; a timer is not I/O.

## Consequences

An allow costs one append before the host may proceed. A broken log stops
every action until it is fixed, by design: the record is evidence, and an
action that leaves none is refused.
