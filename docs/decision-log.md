# The decision log

Every event a host asks about is judged and recorded. The judge-event feature
(`contexts/core/src/application/judging/judge-event/`) decides the event with
the composed guards (`decideEvent`), then records one **decision** through the
`DecisionLog` out port, and returns the verdict the host enforces.

## A decision

One JSON object per decision, plain and serialisable:

```json
{
  "id": "4f0c2a8e-3b1d-4c7e-9a52-6d8e1f0b7c34",
  "time": "2026-10-07T12:00:00.000Z",
  "event": "tool-use",
  "role": "builder",
  "tool": "edit",
  "effects": ["read src/a.ts", "write (modify) generated/api.ts"],
  "verdict": {
    "kind": "refuse",
    "reason": "bounded/path-gate refused write (modify) generated/api.ts: generated files are written by the generator",
    "redirect": "Change the generator's input instead",
    "pack": "bounded/path-gate",
    "effect": "write (modify) generated/api.ts"
  },
  "note": null
}
```

Every decision has an `id`. An allowed decision's verdict is `{ "kind": "allow" }`. A session start has
`tool: null` and no effects. A command's description includes the directory
it runs in, when the host gave one ("execute `make` in apps/web"). `pack` and `effect` are null when no pack's guard
refused (for example, when the core pack is not selected); `effect` is null
for a whole-call refusal.

## When the log fails

Recording must finish within a bound: two seconds by default
(`JudgeEventHandler.DEFAULT_RECORD_WITHIN_MS`), because a host hook waits for
the answer. If the log rejects, throws or takes longer, or the clock fails:

- a refusal stays a refusal, its reason ending "(this decision could not be
  recorded: …)";
- an allow becomes a refusal: "The guards allowed this, but the decision
  could not be recorded: …".

The handler never throws; input that is not a command is refused and not
recorded, and a clock that does not give an ISO 8601 time counts as a failure
to record.

### A late line

A record can land after the bound has passed, when the host has already been
told to refuse. Once it lands, the handler appends a second line with the
**same id**, the enforced refusal as its verdict, and the note
`"not recorded in time; enforced: refuse"`. The second line is appended
once the late record settles, whether it landed or failed; if it never
settles, there is no second line. Read the log by id: **when two lines share
an id, the later one says what was enforced.**

## Refusals a host adapter makes itself

Some calls never become events: the host adapter cannot read or translate
them, or a deadline passes. The adapter still refuses them, and records them
through the project's `refuse({ tool, reason, redirect, role, input })`
(`ProjectJudge`, `bounded/open-project`). The record is a refusal with
`event: "adapter"`, no effects, and `host: { tool, input }`: the host's tool
name and its input written as JSON text (each cut to 4096 code points).
Both adapters hand their own refusals to it without waiting, so a log that
fails never changes or delays what the host is told.

A host adapter must let its process's event loop drain after answering (no
`process.exit` straight after the verdict), or a late line can be lost.

## Reading the file

One JSON object per line. Each record is written by one append of one
complete line, and the file log has been tested with two processes appending
at once. A reader should still skip a line that does not parse (a disk that
filled up mid-write, or a line written by something else) and carry on.
Every text field is at most 4,096 characters (counted in code points, so a
character is never split); longer text ends with
"… (shortened from N characters)". Decision ids come from the `DecisionIds`
port (random UUIDs by default, `RandomDecisionIds` in `bounded/adapters/system`).

## Privacy

Decisions hold commands, paths and URLs as the agent gave them. The file log
creates its file readable and writable by its owner only (mode 0600), and
makes an existing file so on every record.
Installers should add `.bounded/` to the project's `.gitignore` so the log is
never committed. A hook to redact sensitive text before it is recorded is
planned, not built.

## Adapters

| Adapter | Package export | Keeps decisions |
| --- | --- | --- |
| `InMemoryDecisionLog` | `bounded/adapters/in-memory` | in memory, for tests and short-lived hosts |
| `FileSystemDecisionLog` | `bounded/adapters/file-system` | appended to a JSON-lines file, creating its folders |
| `SystemClock` | `bounded/adapters/system` | (the time of each decision) |

The composition root chooses the file, such as
`<project>/.bounded/guard-log.jsonl`. The port is asynchronous so a later
adapter can send decisions to a service. Every log runs the conformance suite
in `judge-event.decision-log.test-support.ts`.

```ts
import { FileSystemDecisionLog } from "bounded/adapters/file-system";
import { SystemClock } from "bounded/adapters/system";
import { JudgeEventCommand, JudgeEventHandler } from "bounded/application";

const judge = new JudgeEventHandler(composition, new FileSystemDecisionLog(`${project}/.bounded/guard-log.jsonl`), new SystemClock());
const command = JudgeEventCommand.parse(hookEvent);
const verdict = command.ok ? await judge.execute(command.value) : { kind: "refuse", reason: command.error, redirect: "Report this to the host adapter's maintainers" };
```
