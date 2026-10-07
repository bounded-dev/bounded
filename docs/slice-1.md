# Slice 1: packs, extension points and composition

Slice 1 builds only the mechanism of Part 1 of [the spec](spec.md): packs,
typed extension points, contributions, and composing the selected packs. No
events, guards, data manifests or path gate yet. All code is in
`contexts/core/src/`.

## Reading order (about 15 minutes)

1. `domain/packs/pack.contract.ts` — the types: a pack, a point declared
   inside it, a contribution, and `StrictSpec`, the compile-time rules.
2. `test/fixtures/compile-time/rejected.ts` — the code that must not compile,
   one line per rule with the reason its error must give; `accepted.ts` shows
   the legitimate forms. `compile-time.test.ts` (repository root) runs the
   TypeScript compiler on them.
3. `domain/packs/pack.ts` — `definePack`, `point` and `contribution`, and how
   composition knows a pack is genuine.
4. `domain/composition/composition.ts` — composition: every run-time refusal
   (it never throws), the dependency order, and the one cast in `read` with
   why it is sound.
5. `domain/composition/composition.test.ts` — the behaviour, one refusal per row.
6. `application/composition/compose-packs/` — the same as a feature: wire
   input, command, in port, out port (the pack catalog) and handler.

The decisions behind it are in [ADR 2026-003](adr/2026-003-packs-refer-to-packs.md)
(and the deviations from the example in [ADR 2026-002](adr/2026-002-typed-extension-points.md)).

## Worked example

```ts
import { Composition, contribution, definePack, point, type Result } from "@bounded/core/domain";

const relativePath = (raw: unknown): Result<string> =>
  typeof raw === "string" && !raw.startsWith("/") ? { ok: true, value: raw.trim() } : { ok: false, error: "use a project-relative path" };

// "rules" declares an extension point and gives it a value of its own.
export const rules = definePack({
  id: "rules",
  points: { protectedPaths: point({ description: "Paths no agent may write", check: relativePath, values: [".git/**"] }) },
});
// "team" depends on the rules pack object and contributes to its point.
export const team = definePack({ id: "team", dependsOn: [rules], contributes: [contribution(rules.points.protectedPaths, [" generated/** "])] });

const composed = Composition.compose([team, rules], ["team", "rules"]);
if (composed.ok) console.log(composed.value.read(rules.points.protectedPaths)); // { ok: true, value: [".git/**", "generated/**"] }
```

Remove `dependsOn: [rules]` from `team` and its contribution stops compiling.
Build `team` from untyped data instead and composition refuses it: "Pack
'team' contributes to extension point 'rules.protectedPaths', owned by pack
'rules', but does not depend on 'rules'. Add 'rules' to the dependencies of
'team', or remove the contribution".
