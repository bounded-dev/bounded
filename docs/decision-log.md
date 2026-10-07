# The decision log

Every event a host asks about is judged and recorded. The judge-event feature
(`contexts/core/src/application/judging/judge-event/`) decides the event with
the composed guards (`decideEvent`), then records one **decision** through the
`DecisionLog` out port, and returns the verdict the host enforces.

## A decision

One JSON object per decision, plain and serialisable:

```json
{
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
  }
}
```

An allowed decision's verdict is `{ "kind": "allow" }`. A session start has
`tool: null` and no effects. `pack` and `effect` are null when no pack's guard
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

The handler never throws.

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
