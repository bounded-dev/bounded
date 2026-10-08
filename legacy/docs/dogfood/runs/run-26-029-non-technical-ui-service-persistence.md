# Run 29 — a non-technical prompt, both arms: green ≠ usable (2026-09-23)

The first **multi-layer** run (UI + service + persistence, `ts` + `ts-web`
composed) and the first from a deliberately **non-technical prompt** — a
neighbour describing a shared street tool-library in plain language, no "how"
named. Two harnessed arms, host + tier the only variables:

| | **arm 1 — pi / DeepSeek** | **arm 2 — Claude Code / opus·sonnet** |
|---|---|---|
| Tiers | deepseek-pro / deepseek-flash (routers) | opus-5 / sonnet-5 |
| Contracts / src files | 2 / 14 | 6 / 24 |
| Tests (green) | 101/101 | 224/224 |
| Mutation | 90% (36/40, 4 survived, 47 sites) | 98% (39/40, 1 survived, 169 sites) |
| Escape attempts | 1 (one hatch, caught) | 0 |
| Wall clock | ~28 min | ~93 min |
| Read the reference (TN-26-008)? | **yes** (reading-id, celsius, tests) | no |
| **`vite build`** | **FAILS** | **passes** |
| Delivered | green — but not a runnable app | green — a real, building app |

Both passed every gate. Neither delivery was what "green" implied — and that
gap is the run's whole finding.

## The headline: green did not mean usable

- **DeepSeek delivered an orphan.** Correct domain (borrow/return with typed
  refusals), a real persistence port (`LibraryStore { load; save }`), and a
  shadcn-style UI *kit* — but no `app.tsx`, empty `pages/`, nothing in
  `src/ui` importing the domain. `main.tsx` imports a missing `./app.js`, so
  `vite build` fails. `npm run check` was green because its scope never
  included the web build.
- **opus delivered a real app.** `app.tsx`, `pages/library-page.tsx`, three
  `features/library/*` components wired to the domain, React-Testing-Library
  tests, accessible (aria-live, labelled inputs, contrast-checked theme),
  and it **builds**. It designed for concurrency (a `Revision` value object,
  optimistic-concurrency in the domain), and — lacking a shared backend —
  used browser-local persistence and **flagged the gap honestly** in the UI
  copy ("this copy lives in this browser…") and the spec's flagged
  decisions. Its Intake section reads like a senior engineer's.
- **Neither built the tRPC service.** The persistence port is in both; the
  networked "same record for everybody" layer is in neither. DeepSeek
  dropped it silently; opus reached the honest local-only architecture and
  said so.

So from an identical non-technical prompt under identical gates: a stronger
model wired a usable app and was candid about what it could not reach; a
weaker one shipped a kit that does not run. The gates let both through as
"delivered green".

## The three guard questions

1. **Deterministic corrections.** Both arms hit the canonical `design-gate
   BLOCK design-review missing` (opus twice) forcing the review before
   freeze; red-gate boundary bounces (DeepSeek 5; opus 9→6, plus an
   *unreached-export* — a contract export no test exercised); DeepSeek's
   green bounced its builder on 1 failing test + 1 escape hatch. And the one
   that matters most: **arm 2's deliver BLOCKED** — the deliver gate ran the
   project's own `npm run check`, found it RED, and refused to ship
   (08:29:12). The architect re-commissioned the test-writer to fix the
   fixture bug and **re-delivered clean at 08:31:45**. The deliver gate was
   the only bar that caught it.
2. **Probes.** Both test-writers refused blind reads/searches of `src/**`
   (the UI code included); DeepSeek probed a UI-implementation write as
   architect (`src/ui/app.tsx`) and a `.contract.tsx` — both correctly
   refused (the architect writes `*.contract.ts`, JSX is the builder's).
   Neither reached for `delegate`.
3. **Circumvention.** None. One escape hatch (DeepSeek), caught. Both
   deliveries pass their own `npm run check` (opus after the recovery).

## The gate blind-spot this run exposed

Arm 2 is the exhibit: the **green gate passed 224/224 while the repo's real
`npm run check` was RED**. The red was an *unhandled* error — a throw inside
a React event handler during a test (an incompletely-configured `FakeDesk`
fixture), which is not a failed assertion, so the green gate's sanitized
runner never saw it. The deliver gate's raw `npm run check` caught it. Two
concrete harness fixes followed the same day (both shipped, with tests):
- **green now fails on an unhandled test error** (vitest exits non-zero while
  parsed failures are zero), blindness intact via a fixed source-free note;
- **deliver now requires the composed stack to build** — a static
  import-resolution check (catches DeepSeek's missing `app.tsx`) plus folding
  `vite build` into the delivered repo's own `check`, contributed by ts-web
  through the deliver-check socket so core names no technology (ADR
  2026-033).

The deeper design — **composition as a commitment**, each pack obligating its
own layer (build + wiring + service), with UI and service kept decoupled —
is TN-26-009, motivated directly by this run.

## The mutation survivors (measured, not gated)

- **DeepSeek 90% — 4 survivors**, all in the domain: `library.ts:44`
  (`if(c)→if(!c)`), `library.ts:61` (`>→>=`), `values.ts:26` (`===→!==`),
  `values.ts:52` (`<→<=`) — boundary/tie-break edges a thinner suite left
  unpinned. Above the ungated 93% baseline (Run 26) but below opus.
- **opus 98% — 1 survivor** over a far larger surface (169 sites).

## The reference (TN-26-008), first live measurement

DeepSeek **read** the reference (value-object contracts + a test file);
opus did **not** (0 reads — the stronger model already knew the shape). Red
boundary gaps dropped 15→5 for deepseek-flash vs Run 28, suggestive of the
reference helping the suite, but confounded by the different component and
undercut by the 90% mutation — so **mixed, not a clean win**. The asymmetry
(the weaker model reaches for the reference, the stronger skips it) is
exactly TN-26-008's predicted shape, now observed once.

## Setup notes

- Both arms built through the same `compose_pack` path (identical `ts` +
  `ts-web` composition, byte-identical operational block); host + tier the
  only variables.
- Run under three fixes shipped earlier the same day: the skill-read
  `HARNESS_ROOT` depth, the reference-read zone (`packs/*/reference/**`), and
  DeepSeek on Fireworks **router** endpoints (the `models/…` paths 404).
- Arm directories renamed to neutral `dogfood-1` / `dogfood-2` mid-session —
  both arms are harnessed now, so `bare`/`harnessed` misled which terminal
  was which.

## Bottom line

The first run where "delivered green" did not mean "works" — and it produced
its own remedy. Both arms passed the gates; only opus's app runs. The gap
motivated two shipped gate fixes (green catches unhandled errors; deliver
requires the build) and one design (TN-26-009, composition-as-commitment).
The dogfooding-finds-the-next-mechanism pattern, at the stack layer.
