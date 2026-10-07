# Slice 1: packs, extension points and composition

Slice 1 builds only the mechanism of Part 1 of [the spec](spec.md): packs,
typed extension points, contributions, and composing the selected packs. No
events, guards, data manifests or path gate yet. All code is in
`contexts/core/src/`.

## Reading order (about 15 minutes)

1. `domain/extension-points/extension-point.contract.ts` — what an extension
   point is: an id, an owner (a literal pack name), a value type and an
   optional check.
2. `domain/packs/contribution.contract.ts` and `domain/packs/pack.contract.ts`
   — a contribution remembers the owner of the point it targets; `PackSpec`
   accepts only contributions to its own or a declared dependency's points.
   This is the compile-time check. `domain/packs/one-literal.contract.ts`
   keeps it from being switched off by a widened name.
3. `test/fixtures/compile-time/rejected.ts` — the code that must not compile,
   one line per rule with the reason its error must give;
   `compile-time.test.ts` (repository root) runs the TypeScript compiler on it.
4. `domain/composition/composition.ts` — composition, every refusal (it never
   throws), the dependency order, and the one cast in `read` with why it is
   sound.
5. `domain/composition/composition.test.ts` — the behaviour, one refusal per row.
6. `application/composition/compose-packs/` — the same as a feature: wire
   input, command, in port, out port (the pack catalog) and handler.
7. `domain/packs/pack-name.ts` — the value-object pattern every concept follows.

The decisions behind it are in [ADR 2026-002](adr/2026-002-typed-extension-points.md).

## Worked example

```ts
import { Composition, Contribution, ExtensionPoint, Pack, PackName } from "@bounded/core/domain";

// "rules" owns an extension point; "team" depends on it and contributes to it.
const protectedPaths = ExtensionPoint.ownedBy("rules").declare<string>({
  id: "rules.protected-paths", description: "Paths no agent may write",
  check: (path) => (path.startsWith("/") ? "use a project-relative path" : undefined),
});
const rules = new Pack({ name: "rules", declares: [protectedPaths], contributes: [new Contribution(protectedPaths, [".git/**"])] });
const team = new Pack({ name: "team", dependsOn: ["rules"], contributes: [new Contribution(protectedPaths, ["generated/**"])] });

const selected = ["team", "rules"].map((n) => PackName.parse(n)).flatMap((r) => (r.ok ? [r.value] : []));
const composed = Composition.compose([team, rules], selected);
if (composed.ok) console.log(composed.value.read(protectedPaths)); // { ok: true, value: [".git/**", "generated/**"] }
```

Remove `dependsOn: ["rules"]` from `team` and the `new Contribution(...)` in
`team` stops compiling. Build `team` from untyped data instead and
composition refuses it: "Pack 'team' contributes to extension point
'rules.protected-paths', owned by pack 'rules', but does not depend on
'rules'. Add 'rules' to the dependencies of 'team', or remove the
contribution".
