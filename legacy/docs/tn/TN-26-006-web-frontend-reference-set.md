---
number: TN-26-006
title: The web-frontend reference set — FSD layers, shadcn, and the typed client
kind: design
status: draft
issue: (pending)
---

# The web-frontend reference set

The path to a full web-app MVP runs through the one part the harness has
never built: the frontend. This note plans the `ts-web` pack — the second
real pack (TN-26-005 composition applies: its own `contrib.json`, a declared
dependency on the ts pack, nothing implicit) — and the dogfood ladder that
proves it.

## Ratified at the 2026-09-14 grill

- **Blessed web stack:** React, Vite, TanStack Query, `@trpc/client`,
  Tailwind, shadcn/ui — exact-pinned by the pack (ADR 2026-029 applies).
- **shadcn components are pack-owned in v1**: vendored by the generator with
  generated markers, never hand-edited; restyling happens through the
  Tailwind token layer. Revisit if a real project needs a variant tokens
  cannot express.
- **Scoped primitives relaxation:** contracts under the generic UI layer are
  exempt from `no-naked-primitives` (a Button's `label: string` is
  legitimate); everywhere else the rule stands, so domain data crosses into
  feature components as value objects and is rendered to primitives at the
  leaf.
- **`check` grows a production build** (`vite build`) at delivery only — the
  inner red/green loop stays fast.

## Structure: Feature-Sliced Design, pruned to four layers

FSD is the enforceable form of the dumb-vs-domain-aware split — its core law
(imports flow strictly downward; each slice exposes a public API through its
index) is lint material, its vocabulary is in every model's training data,
and its layer split aligns with the wire's CQRS (ADR 2026-030): `entities`
own read models and queries, `features` own commands and forms.

```
src/ui/
  shared/     ui (shadcn kit, generated) · api (the ONE door: trpc client + query client)
  entities/   read side — display components + query hooks per domain entity
  features/   write side — forms/actions + command hooks per user interaction
  pages/      routes composing the above
```

`widgets` is reserved (lints know the name; the generator does not emit it);
`processes` is dropped (deprecated by FSD itself). Enforced, all as pack
lint rules: downward-only imports; slice-public-API imports only; `@trpc/*`
and TanStack Query legal only inside `shared/api`; no domain imports in
`shared`; styling libraries other than Tailwind refused
(`blessed-stacks-only` grows the nouns via contrib.json: vue, angular,
svelte, mui, chakra, styled-components, emotion, bootstrap, …).

## The build, in slices

**A — plumbing.** A1: TSX through every gate (lint globs, scaffolder emits
`.tsx` throwing skeletons for component-declaring contracts, JSX tsconfig,
red/green untouched). A2: the router-type re-export becomes a purity rule —
both r23 services legally omitted it, and the typed client depends on it.

**B — the `ts-web` pack.** B1: generator emits the FSD skeleton, Vite,
Tailwind, `main.tsx`, all marker-generated; `contrib.json` carries the
pack's nouns and pins. B2: the directional lints and the primitives
relaxation. B3: shadcn vendoring through the generator. B4: the `ts-web-app`
skill (guidance last) and the ask-shaped routing line.

**B landed (2026-09-16).** The socket registry is `agent/src/socket-registry.ts`
(see TN-26-005); the ts pack defines `lintSrcRules` and
`contractPurityOverrides`, ts-web fills both over its declared edge.
`packs/ts-web/scripts/new-web-app.ts` emits the layout and is keyed on tree
content: `shared/api/client.tsx` appears only once a contract re-exports
`ServiceRouter`, so r24 (no API) typechecks and r25's re-run wires the door.
`src/ui/app.tsx` is deliberately NOT emitted — it is the architect's contract,
scaffolded like any other. The kit is button/card/input/label + `cn`, with
clsx+tailwind-merge kept (the merge is what makes a caller's `className`
actually win) and cva and Radix dropped as dependencies nothing yet needs.
Three deviations worth recording: the client is `client.tsx`, not `.ts`, because
it exports a component; `raw-framework-entry` was refusing `@trpc/client` and is
now the SERVER door only, with `client-one-door` owning the client side; and the
scaffolder's prune is narrowed to the ts pack's own generators, which was one
`design_gate` away from deleting `src/ui/main.tsx`.

**Still open after B.** `blessed-stacks-only` does not yet grow its banned-noun
list from `contrib.json`, so a builder importing `styled-components` is caught
by the spec-intake denylist but not by the src gate. The rule's own header
already names this as the plan; it is a data-only contribution, not a socket.

**C — app assembly.** `npm run dev` = Vite + the service's HTTP entry,
proxy wiring; deliver pins web deps keyed on tree content; dogfood arms
scaffold them from birth; first genuine use of composition-at-initiation
(TN-26-005). Plus **the pack-contributed TOOL socket**: the architect has no
`bash`, so every capability it holds is a named tool wired in the core — and
the core may not name a technology. `render-screenshot` (below) is the first
capability that wants to be one and cannot be, so it ships driver-side and
waits for the socket to be born with it: the core would own "a pack may expose
a driver tool", ts-web would contribute `render_screenshot`, and the tool would
appear only in projects composing the pack.

**D — the dogfood ladder.**
- **r24**: props-driven UI ticket, no API ("a screen that renders building
  status") — proves TSX, layering lints, shadcn, and blind UI testing in
  isolation.
- **r25**: change run wiring it to the service — typed client end to end,
  hooks discipline; `BAD_REQUEST` field-path detail lands here, where forms
  make it a user need.
- **r26**: the capstone — empty arm, one-sentence ticket ("facility
  managers need a dashboard to submit reports and see status"), full stack,
  headless, `npm run dev` works; plus an adversarial variant naming a
  banned framework.

## Styling: anatomy enforced, identity free (2026-09-16, from r24's bare screen)

r24 delivered a behaviourally perfect, visually bare screen — the predicted
gap performing on schedule. The architecture that closes it without
surrendering flexibility splits style into two surfaces:

- **Anatomy** (kit markup, a11y, states, variants, spacing relationships,
  and the layout primitives r24 lacked — PageShell, Badge with band
  variants, list/stat pieces): pack-owned, marker-generated, identical
  everywhere. The styled path becomes the default path, so a blind builder
  composing the kit produces a decent screen by construction.
- **Identity** (colours, radii, fonts, shadows, density): the `@theme`
  token block moves to `src/ui/theme.css`, the ONE project-owned style file
  — emitted as a starter, never overwritten, freely edited. A fresh look
  per project is a fresh token file and nothing else.

Two mechanical guarantees make the freedom safe:

1. **`tokens-only-styling` lint** (ts-web contribution): components and
   features style only through semantic tokens — no raw palette
   (`bg-blue-500`), no arbitrary values (`bg-[#…]`). The styling twin of
   no-naked-primitives; it is what makes a theme swap total.
2. **A theme gate**: every required token defined, and WCAG contrast
   computed over the declared fg/bg pairs — any look, never an unreadable
   or incomplete one.

Taste stays judged, not gated: a brand brief lands with the PM/design pass
that writes `theme.css`; a screenshot rendered at wrap (the visual twin of
`mutation_score`, advisory) gives the reviewer and the user pixels to
judge. A variant tokens cannot express is a kit change through the change
cycle — deliberate, never ad hoc.

**Landed (2026-09-17), in four pieces.** The kit grew `PageShell`, `Badge`,
`Stat` and `DataList`/`DataListItem` — generic, tone-variant, `children`
required on a Badge so a colour-only chip is a compile error; a test pins that
no domain noun reaches the kit's code. `src/ui/theme.css` is the generator's one
SEED (`webAppSeeds` beside `webAppPlan`): unmarked, written when absent, never
restored, and `app.css` imports it. The token contract is data —
`requiredThemeTokens` and `contrastPairs` in `contrib.json`, read by the pack's
own typed reader, never by the core. The two fences are
`bounded-ts-web/tokens-only-styling` (raw palette and hand-written colours
refused in `src/ui/**`; `bg-[var(--…)]` and non-colour arbitrary values stay
legal, which the rule header states as a v1 scope) and `theme-check`, which
rides a NEW socket the ts pack defines — `deliverChecks`, ADR 2026-033 — and
measures oklch/hex/rgb against WCAG AA in the base theme and every media
variant. One deviation worth recording: `--color-muted-foreground` moved 0.55 →
0.52, because the starter theme contrasted 4.45:1 against `--color-muted` and
would have blocked on its own gate. `render-screenshot.ts` is the advisory eye,
driver-side pending the tool socket (Phase C).

**The eye earned itself on its first run.** Two findings no test could have
produced: the script hung for five minutes because `spawnSync` blocks the event
loop, so the static server could not answer the browser it had just launched
(every command is `spawn` now); and the first screenshot showed the Badge as a
full-width red bar — a flex item in a `flex-col` CardHeader stretches, and
`inline-flex` says nothing about width. `w-fit`, one line, invisible to 1900
green tests. That is the gap the pixels exist to close, and it closed on day
one.

## Named risks

- **Blind UI testing is the experiment.** The test-writer keys on roles,
  labels and observable behaviour, so specs must state them ("shows the
  inspection queue count when any meter is excluded") — spec discipline the
  skill must teach; r24 exists to find out how the worker copes.
- **Visual quality has no gate and never will** — reviewer and sign-off
  carry it; the MVP is the first run where that gap is load-bearing.
- Suite runtime grows (jsdom); watch red/green wall time.
- Layer misplacement is expected early — the lints make it a bounce, not a
  debate; watch the friction counters for rules that need better messages.
