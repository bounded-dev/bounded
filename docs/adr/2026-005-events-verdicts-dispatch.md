# 2026-005: Host-neutral events, verdicts and a pure dispatch

**Status:** accepted. The tool-use shape is superseded by
[ADR 2026-006](2026-006-effects.md) (a list of effects); the guards extension
points and dispatch over a composition are in
[ADR 2026-007](2026-007-guards-over-a-composition.md).

## Decision

- **Events are a closed, host-neutral vocabulary.** `ToolUse { role, tool,
  action, paths, command, search }` and `SessionStart { role }`, discriminated
  by `kind`. `tool` is one of read, search, edit, write, shell, web, subagent,
  other; `action` is read, write or run. Only a run has a command (a string,
  else null) and only a search has search details (`{ root, filter }`, or
  null when the host does not say where it searched). `role` must be given:
  a role label, or null for none. Tool kind and action are independent: the
  host classifies both, and no rule ties one to the other. A command must not
  contain NUL. Nothing names a host, tool product or technology.
- **Paths arrive resolved.** The host adapter rewrites its own paths and
  resolves links (it does the I/O); `ProjectPath` only checks and normalises:
  Unicode NFC, relative to the project, '/'-separated, no '.', empty or
  climbing '..' segments, no control characters. Absolute paths, '~', drive
  letters (`C:` or `C:/...`), URLs and backslashes are refused rather than
  guessed at. The root is ".". Case-folding and Windows' trailing dots and
  spaces depend on the file system, so they are the adapter's job.
- **A verdict is allow or refuse { reason, redirect }**, both non-empty,
  discriminated by `kind` so that a third form (such as allowing with
  rewritten input) can be added later without changing the other two.
  `Verdict.refuse` with blank text still refuses, with text saying what is
  missing; `Verdict.parse` refuses blank text.
- **A guard is `(event, context) => Verdict`**, synchronous. `Context` is a
  type parameter the integration fills with the composed result, which the
  integrated dispatch always passes. A guard that does not need it is a
  `Guard<E>` (context `unknown`), so it sits in any list; guards in one list
  must agree on their context, and dispatch requires the context whenever
  one of them needs a particular one.
- **`dispatch(guards, event, context?)` is a pure domain function.** It
  checks the event with `Event.parse` and gives every guard the checked
  event (frozen, normalised, the vocabulary's fields only), runs the guards
  in the order given,
  re-checks each result with `Verdict.parse`, and returns the first refusal,
  or allow. A guard that is not a function, throws, returns a promise or
  returns anything but a verdict is a refusal naming the guard by position
  and the failure. It never throws.

## Deviations from the example

- **Frozen plain objects with type-only brands**, not `<Name>Impl` classes:
  as `PackId`, the brand stops a look-alike literal at compile time, and
  every run-time entry point (`parse`, `dispatch`) checks the shape again, so
  untyped data is held to the same rules. A brand can be forged by a cast
  or by spreading a genuine value into a changed copy; the run-time parse
  catches it, and guards only ever see checked events. Every `parse` reads
  own fields only, each once, and returns a `Result`, never throwing. Role
  and ProjectPath are branded strings, readable in messages.
- **A function-valued type in the domain** (`Guard`), and a domain function
  rather than an application feature for dispatch: it has no port and does
  no I/O. The integrated dispatch over a composition may become a feature.
- **Guards are named by position, not function name**: names do not survive
  every transpiler. The integration will name the contributing pack.
