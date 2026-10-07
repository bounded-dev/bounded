# Slice 2 (first half): events, verdicts, guards and dispatch

This half builds the host-neutral vocabulary of Part 2 of [the spec](spec.md)
and a pure dispatch over a list of guards. It does not yet declare the core's
guards extension points or dispatch over a composition: that joins slice 1's
packs once their API settles. All code is in `contexts/core/src/domain/`.

## Reading order (about 10 minutes)

1. `events/tool-use.contract.ts` and `events/session-start.contract.ts` — the
   two events. Then `events/role.ts` and `events/project-path.ts`, the two
   checked strings they are made of.
2. `events/tool-use.ts` — every refusal a host adapter can meet, in order.
3. `verdicts/verdict.contract.ts` — allow, or refuse with a reason and a redirect.
4. `guards/guard.contract.ts`, then `guards/dispatch.ts` — the guard type,
   the context placeholder, and how dispatch fails closed without throwing.
5. `guards/dispatch.test.ts` — the behaviour; `test/fixtures/compile-time/events-rejected.ts`
   — what does not compile, with reasons (`events-accepted.ts` shows the
   legitimate forms).

The decisions are in [ADR 2026-005](adr/2026-005-events-verdicts-dispatch.md).

## What a host adapter and a guard can rely on

- A tool use lists **every path** the call touches, already resolved by the
  adapter; a guard that refuses any one of them refuses the whole call.
- A search may say **where** it searches (`search.root`) and the file-name
  filter that limits it; the content pattern is not part of the event.
- Verdicts are discriminated by `kind`. Only allow and refuse exist; a third
  form (allowing with rewritten input) is left open, not built.

## Worked example

```ts
import { dispatch, type Guard, ToolUse, Verdict } from "bounded/domain";

const noGenerated: Guard<ToolUse> = (event) =>
  event.action === "write" && event.paths.some((path) => path.startsWith("generated/"))
    ? Verdict.refuse("generated/ is written by the generator", "Change the generator's input instead")
    : Verdict.allow;

// A host adapter turns its own hook call into an event, dispatches, and translates the verdict back.
const event = ToolUse.parse({ role: "builder", tool: "edit", action: "write", paths: ["./generated//api.ts"] });
if (event.ok) console.log(dispatch([noGenerated], event.value));
// { kind: "refuse", reason: "generated/ is written by the generator", redirect: "Change the generator's input instead" }
```

Return `true` from the guard and it does not compile. Bring the same guard in
untyped and dispatch refuses instead: "Guard 1 of 1 returned something that
is not a verdict: A verdict is { kind: 'allow' } or { kind: 'refuse', reason,
redirect } with a non-empty reason and redirect".
