# Run 24 — the first web-frontend run: a screen, blind-tested, delivered
r24 is the web reference set's first outing (TN-26-006 D): a fresh kimi arm
composed with the ts-web pack (`dogfood-reset --compose ts-web` — pins and
the FSD layout arrive from the pack's own manifest, the reset script names
nothing), fed a product-voice ticket for a props-driven building-status
screen. No backend, by design: the run isolates exactly the new machinery.

| | r24 (building-status screen) |
|---|---|
| result | GREEN 77/77, **delivered headless, zero intervention, 23m12s** |
| phases | design 7m12s · tests 5m06s ∥ build 12m06s · wrap 1m30s |
| red | 76 NotImplemented, 0 passed — over **jsdom component tests** |
| mutation | 96% → survivor closed → **100%** (the r16 measure-loop, on JSX) |
| sign-off | 1 finding, 0 blockers |
| friction / iteration | 7 refusals / 12 |

**1. Blind UI testing works.** The experiment the whole phase existed to run:
a test-writer that cannot see the screen pinned it anyway, keying on the
spec's observable behaviours (verdict text visible, worst-first order,
"Inspection queue (3)" count, units on every number). The spec carried the
jsdom instruction the skill told the architect to include, and both test
files open with the `@vitest-environment jsdom` pragma. The red gate coached
the suite honestly on the way: one wrong-reason red, then 8 boundary gaps,
then a clean 76/0.

**2. The structure landed without being asked for.** `app.contract.ts`
declared (healing the generator's one deliberate dangling import), view
value objects in `entities/heating-values`, the screen in
`pages/building-status`, the kit imported from `shared/ui`, component
contracts scaffolding to `.tsx`. The FSD lints never had to block a layer
violation — steering by structure, the r19 pattern repeating on a new stack.

**3. The guardrails transferred to JSX unchanged.** Green's first verdict:
5 failing tests + **4 escape hatches** — the builder reached for casts to
quiet JSX prop types, lint-src refused, and the resume fixed all four in
one pass. The phase gate also refused a `delegate` spawn (an unbound writer
inside the pipeline) — first live firing of that particular refusal.

**4. 100% mutation on UI code.** kimi measured 96%, closed the survivor,
re-measured 100% — the measure-loop working on rendered components exactly
as it does on domain arithmetic.

Residue: visual quality remains ungated as designed (the sign-off's one
finding is a reading of the screen, not a gate result); r25 wires this
screen to the r23 service over the typed client and lands the BAD_REQUEST
field-path work; full Phase C (npm run dev, vite build at deliver, deliver
pins for web) comes first. Arm committed at `d328dbe`.
