# Run 22 — the first stack run: a tRPC service over the delivered core
r22 answers "could the harness build a real app's backend?" with the first
framework on the table. Same arm, same kimi tiers, third run on one
repository: the driver advanced the tree to r21's change-1 result, installed
the run's one sanctioned dependency (`@trpc/server` 11.18.0, exact-pinned),
opened the run boundary, and fed `heating-cockpit-trpc-prompt.md` — add a
tRPC service layer as a **second component** consuming the core only through
its public surface, validation reusing the core's parse-based value objects
(no zod: a second schema would be a second identity, ADR 2026-023), errors
mapped totally onto tRPC codes, tested through `createCaller` with no socket.

| | change run 2 (tRPC service) |
|---|---|
| result | GREEN 142/142, **delivered headless, zero intervention, 24m58s** |
| design | 7m26s — one review cycle: 8 findings, **2 blockers**, settled and frozen |
| red | 142 NotImplemented, 0 passed |
| green | blocked once — **5 escape hatches**, routed to builder, clean 72s later |
| mutation | 90% — 2 survivors confessed as real coverage holes, 2 argued equivalent |
| core delta | **+8 lines**: one store-port read (`findByBuildingAndPeriod`), reviewer-endorsed |
| friction / iteration | 3 refusals / 16 (13 typecheck — the builder learning tRPC's types) |

**1. Composition held.** The service consumed the core exactly as a stranger
would — `import type { BuildingReportStore, Clock } from
'../heating-cockpit/heating-cockpit.js'` — and the only core change the whole
run made was the minimal read seam the query genuinely needed, which the
reviewer named "the right minimal seam" before a line of it was implemented.
Core behaviour tests: untouched except the fake store growing the new method.
The per-component loop composes within one architect and one repo; several
architects and a merge remain the untested half.

**2. The reviewer caught the stack's real friction point at design time.**
Its two blockers were the wire boundary itself — procedure JSON shapes
unspecified, and a branded `ThresholdSet` that cannot arrive as JSON (the fix
became a threshold-set *name* looked up server-side). And its sharpest
concern was the type erasure: the architect declared `ServiceRouter =
AnyRouter`, which "erases the promised typed client". The architect froze
over it, and the sign-off confesses the consequence honestly: client *output*
types are concrete, client *input* types collapse to `unknown` because the
parsers take `unknown`. The finding chain — reviewer → freeze-over → sign-off
— carried the run's one genuine compromise end to end without losing it.

**3. That compromise is the stack-pack work item, stated by the run itself.**
A declaration-only contract cannot hold an inference-first framework's
precision: tRPC's whole value is a router type *inferred* from the
implementation, and the contract discipline forced the architect to choose
between hand-declaring the procedure surface (drift-prone) and erasing it
(`AnyRouter`). The pack needs a sanctioned pattern here — the contract
re-exporting the implementation router's inferred type is legal under ADR
2026-026's import-from-implementation rule and was simply not reached for.
That, plus a wire-boundary convention (raw-JSON shape ↔ value-object parse ↔
error code), is `packs/ts`'s tRPC layer, and this run is its requirements
document.

**4. The guardrails transferred to framework code unchanged.** lint-src found
5 escape hatches in the first tRPC-facing implementation (the builder
reaching for casts to satisfy generic soup) and green refused; one resume of
the existing builder cleaned all five in 72 seconds. The 13 typecheck
iterations are the builder metabolising tRPC's generics — iteration, not
friction, exactly the distinction the two counters exist to make. And the
architect's first act of the run was reading `node_modules/@trpc/server`
through gated `git ls-files` — learning the dependency inside its zone rules.

**Artifacts.** Arm repo: delivered on branch `run22-trpc` (parent `a5a87d9`,
the dep-install commit); arm reset to `a5a87d9`. Cumulative story on one
tree: r21 baseline → r21 change-1 → r22 service, three deliveries, guard logs
archived per run under `.pi/guard-log-archive/`. Open items sharpened here:
the tRPC contract pattern + wire-boundary convention for `packs/ts`; the two
confessed coverage holes (top-level non-object body, unsupported
threshold-set name) as ready-made change-request prompts; react remains
untouched — the service run says nothing yet about UI.
