# Slice 2: events, verdicts, guards and dispatch

Slice 2 builds the host-neutral vocabulary of Part 2 of [the spec](spec.md),
a pure dispatch over a list of guards, and (see Integration below) the core
pack's guard points and dispatch over a composition. All code is in
`contexts/core/src/domain/`.

## Reading order (about 10 minutes)

1. `events/tool-use.contract.ts`, `events/effect.contract.ts` and
   `events/session-start.contract.ts` — the two events and the seven effects
   a tool use is made of (ADR 2026-006). Then `events/role.ts` and
   `events/project-path.ts`, the two checked strings they use.
2. `events/effect.ts` and `events/tool-use.ts` — every refusal a host adapter
   can meet, in order.
3. `verdicts/verdict.contract.ts` — allow, or refuse with a reason and a redirect.
4. `guards/dispatch.contract.ts`, then `guards/dispatch.ts` — the guard type,
   the context placeholder, and how dispatch fails closed without throwing;
   `guards/core-pack.contract.ts`, every point of the core pack.
5. `guards/dispatch.test.ts` — the behaviour; `test/fixtures/compile-time/events-rejected.ts`
   — what does not compile, with reasons (`events-accepted.ts` shows the
   legitimate forms).

The decisions are in [ADR 2026-005](adr/2026-005-events-verdicts-dispatch.md).

## What a host adapter and a guard can rely on

- A guard sees only the **checked event**: frozen, its paths normalised, and
  none of the host's extra fields.
- A tool use lists **every effect** of the call (read, list, write, execute,
  fetch, delegate, invoke), paths already resolved by the adapter; a guard
  that refuses any one effect refuses the whole call.
- How tools map: a glob is a `list`; a content search is a `list` and a
  `read` over the same root; a multi-edit is several `modify` writes; a
  rename is a `delete` and a `create`; a shell command is an `execute`, with
  `cwd` the project directory it runs in; a
  tool whose effects the host cannot describe is an `invoke`.
- The tool kind is kept beside the effects, for allowlists of tools.
- Verdicts are discriminated by `kind`. Only allow and refuse exist; a third
  form (allowing with rewritten input) is left open, not built, and until
  it exists a guard returning one is refused.

## Worked example (a list of guards)

```ts
import { dispatch, type Guard, ToolUse, Verdict } from "bounded/domain";

const noGenerated: Guard<ToolUse> = (event) =>
  event.effects.some((effect) => effect.kind === "write" && effect.path.value.startsWith("generated/"))
    ? Verdict.refuse("generated/ is written by the generator", "Change the generator's input instead")
    : Verdict.allow;

const event = ToolUse.parse({ role: "builder", tool: "edit", effects: [{ kind: "write", path: "./generated//api.ts", change: "modify" }] });
if (event.ok) console.log(dispatch([noGenerated], event.value));
// { kind: "refuse", reason: "generated/ is written by the generator", redirect: "Change the generator's input instead" }
```

## Integration: guards as pack contributions

The core pack, `corePack` (`bounded/core`), declares the guard points: one
for whole calls (`toolUseGuards`), one for session starts, and a group with one
point per effect kind (`effectGuards.read`, `.list`, `.write`, `.execute`,
`.fetch`, `.delegate`, `.invoke`), typed from `EffectByKind`, the one map from
an effect kind to its type; dispatch finds an effect's point by its kind,
without a switch or a type assertion (ADR 2026-013). A pack contributes guards
by depending on `corePack`. `dispatchEvent(composition, event)` runs the
whole-call guards, then each effect through the guards for its kind, in pack
order; the first refusal wins and names the pack and the effect. Without the
core pack selected, every event is refused (ADR 2026-007).

Reading order: `guards/core-pack.ts`, `guards/dispatch-event.ts`, then
`guards/dispatch-event.test.ts` and the fixtures `guards-accepted.ts` and
`guards-rejected.ts`.

```ts
import { Composition, contribution, corePack, definePack, dispatchEvent, packIdsFor, point, type Result, ToolUse, Verdict, type WriteEffect } from "bounded/domain";

const packId = packIdsFor("my-rules");
const prefix = (raw: unknown): Result<string> => (typeof raw === "string" && raw !== "" ? { ok: true, value: raw } : { ok: false, error: "a prefix is text" });

// "rules" declares the paths nobody writes; "gate" depends on the core and on rules, and guards writes.
export const rules = definePack({ id: packId("rules"), points: { generated: point({ description: "Generated path prefixes", check: prefix, values: ["generated/"] }) } });
export const gate = definePack({
  id: packId("gate"),
  dependsOn: [corePack, rules],
  contributes: [
    contribution(corePack.points.effectGuards.write, [
      (effect: WriteEffect, composition) => {
        const generated = composition.read(rules.points.generated);
        return generated.ok && generated.value.some((p) => effect.path.value.startsWith(p)) ? Verdict.refuse("it is generated", "Change the generator's input instead") : Verdict.allow;
      },
    ]),
  ],
});

const composed = Composition.compose([corePack, rules, gate], [corePack, rules, gate]);
const call = ToolUse.parse({ role: "builder", tool: "edit", effects: [{ kind: "read", path: "src/a.ts" }, { kind: "write", path: "generated/api.ts", change: "modify" }] });
if (composed.ok && call.ok) console.log(dispatchEvent(composed.value, call.value));
// { kind: "refuse", reason: "my-rules/gate refused write (modify) generated/api.ts: it is generated", redirect: "Change the generator's input instead" }
```

A guard written for a read does not compile on `effectGuards.write`, a
contribution to the group itself does not compile, and a pack
contributing guards without `corePack` in `dependsOn` does not compile.
