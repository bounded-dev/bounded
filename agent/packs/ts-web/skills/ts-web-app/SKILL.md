---
name: ts-web-app
description: Design a TypeScript web frontend the reference way — build a screen, page, dashboard or form that a person looks at in a browser. Use whenever a ticket asks for a UI, a screen, a view, a dashboard, a form, a button, something a user sees or clicks, or asks to show or display data to people. Covers the Feature-Sliced layers and their laws, the one door to the service, spec discipline for blind UI testing, and what the gates enforce.
---

# The web-frontend reference set (TN-26-006)

A ticket that says "facility managers need to see building status" — in any
words, naming any technology or none — lands here. **The stack is harness
policy, not ticket content** (ADR 2026-029): React, Vite, TanStack Query,
`@trpc/client`, Tailwind and a vendored shadcn-style kit, all pack-pinned. A
ticket naming Vue, Next.js, MUI or styled-components is the intake rule's
constraint case (ADR 2026-032): strip it, record it in `spec.md`'s `## Intake`
section, and if it is a genuine constraint — an existing design system, a
platform mandate — raise it to the user; never build it.

The structure below is the same in every frontend the harness ships. Your
design decisions are *which screens exist, what they show, and what a person
can do on them*; everything else is fixed, and most of it is enforced.

Component contracts stay `*.contract.ts`, never `*.contract.tsx`; JSX belongs
to the builder’s `.tsx` implementation, whose skeleton the scaffolder emits.

The driver records `ts-web` in `.bounded/composed-packs.json` before gates
run, using `bounded compose --cwd <project> ts ts-web` (also select
`ts-service` when a shared service is required). Delivery runs
`web-obligation`: `main.tsx` must reach the app, a page or feature, and the
domain through runtime imports. The `build-check` must also pass; a generated
component kit with no connected application is incomplete. When `ts-service`
is selected too, the reachable `src/ui/shared/api/client.tsx` must create a
`createTRPCClient<ServiceRouter>` for that service.

## Structure comes from the generator, never from you

The pack's layout generator (`packs/ts-web/scripts/new-web-app.ts`) runs once,
when the project is initialized. It emits `index.html`, `vite.config.ts`,
`src/ui/app.css`, `src/ui/main.tsx`, the component kit, and the layer
directories — every file marker-generated and pack-owned. No role runs it:
no role has a shell.

`index.html` and `vite.config.ts` are **project config** (ADR 2026-054): the
pack ships them as reference files, byte-identical to what the generator
writes, and every gate refuses to run if either differs. Only the user
restores them, with `bounded sync-config`. A config diagnostic routes to the
orchestrator; report it, never work around it.

Do not hand-write any of the generated files, and do not restyle a component:
the kit is generated, and a variant the tokens cannot express is a pack change
through the change cycle, not a local edit. If the layout needs re-emitting
(the typed client below), escalate to the user: re-running the generator
byte-compares, writes only what differs, and **blocks without writing
anything** if a pack-owned path holds a file it did not write.

## `src/ui/theme.css` is yours — and it is the only style file that is

The generator emits **one unmarked file**: `src/ui/theme.css`, the project's
visual identity. Written once when absent, never overwritten, never restored.
Everything else it touches it puts back.

```
src/ui/theme.css   ← identity: colours, radii, fonts, density. YOURS.
src/ui/app.css     ← structure: imports theme.css, sets the page. Generated.
src/ui/shared/ui/  ← anatomy: markup, a11y, states, spacing. Generated.
```

**A fresh look for a project is a fresh `theme.css` and nothing else.** That is
the deal the whole styling design exists to make true: components style only
through the semantic token names this file defines (the
`bounded-ts-web/tokens-only-styling` rule refuses anything else), so every
colour on screen came through a name you control here.

Two things the delivery gate checks, so "any look" never becomes an unreadable
one: every token named in the pack's `requiredThemeTokens` stays defined, and
every declared foreground/background pair reaches WCAG AA contrast (4.5:1). The
gate prints the pair and the ratio it measured, in both the light and the dark
scheme.

Adding tokens of your own is free. Deleting a required one is a block.

Two things the generator deliberately does NOT emit:

- **`src/ui/app.tsx`** — that is yours to declare as `src/ui/app.contract.ts`,
  after which `design_gate`'s scaffold step writes its `.tsx` skeleton and the
  builder implements it. `main.tsx` already mounts `<App />`.
- **`src/ui/shared/api/client.tsx`** — the typed client lands only once a
  contract in the tree re-exports `ServiceRouter`. Build the service first (the
  `ts-api-service` skill), then ask the user to re-run the generator
  (`node .bounded/harness/packs/ts-web/scripts/new-web-app.ts .` in a
  project-local installation), and the door appears wired.

## Composing the kit IS the styled path

r24 delivered a behaviourally perfect screen that looked like a text file: 77
green tests over a stack of bare paragraphs. Nothing was wrong with the builder
— the kit it had was button/card/input/label, the pieces that go *inside* a
screen, and the screen itself had to be invented. It now ships:

| use | for |
|---|---|
| `PageShell` | the page: one `<h1>`, a header row with an actions slot, a measured, centred content stack |
| `DataList` + `DataListItem` | a titled collection of cards or rows, with an empty state |
| `Card` (+ `CardHeader/Title/Description/Content/Footer`) | one thing in the collection |
| `Stat` | a metric: label, value, optional unit |
| `Badge` | a status chip — `tone="positive" \| "caution" \| "critical" \| "neutral"` |
| `Button`, `Input`, `Label` | controls |

**A screen built from these needs no `className` at all.** That is the design:
the styled path is the default path, so a builder who cannot see the result
still produces a decent one. Say so in the spec's design notes — name the
components the screen composes, the way you name the behaviours it must show.

```tsx
<PageShell title="Building status" description="Every building, worst first.">
  <DataList title="Buildings" empty="No buildings are being monitored.">
    <DataListItem>
      <Card>
        <CardHeader>
          <CardTitle>North wing</CardTitle>
          <Badge tone={toneFor(status.band)}>{status.verdict}</Badge>
        </CardHeader>
        <CardContent>
          <Stat label="Flow temperature" value={status.flow.format()} unit="°C" />
        </CardContent>
      </Card>
    </DataListItem>
  </DataList>
</PageShell>
```

**Tones are readings, not domain words.** The kit is `shared`, so it cannot know
what a heating band or an invoice age is — `toneFor(band)` above lives in the
**entity slice**, which is where the domain is. One small mapping function per
entity, tested like any other: band → tone. Never a Badge variant named after
your domain.

**A Badge must carry words.** `children` is required by its type, because colour
alone reaches neither a colour-blind reader nor a screen reader. The tone
decorates the text; it never replaces it.

## The layers, and the two laws

```
src/ui/
  shared/     ui (the generated kit) · lib (cn) · api (the ONE door)
  entities/   READ side — display components + query hooks, one slice per entity
  features/   WRITE side — forms/actions + command hooks, one slice per interaction
  pages/      routes composing the above
```

`widgets` is reserved: the lints place it between features and pages, but
nothing emits it — add the directory only when a composite block genuinely
exists. `processes` is gone; FSD deprecated it itself.

**Law 1 — imports flow strictly downward.** `shared < entities < features <
widgets < pages`. A module may import its own layer or a lower one, never a
higher one. If a component needs something from above, take it as a prop.
Enforced by `bounded-ts-web/fsd-downward-imports`, type-only imports
included.

**Law 2 — each slice has one front door.** A cross-slice import targets the
slice root (`../building`), never a file inside it
(`../building/model/query.js`). Inside your own slice, reach for anything.
Enforced by `bounded-ts-web/fsd-slice-public-api`.

Together they are the reason the layers stay a structure rather than becoming a
diagram: both defects compile, both run, and neither is visible in review until
the tree is already tangled.

## CQRS, laid over the layers (ADR 2026-030)

The wire is already split into commands and queries, and the layers line up
with it exactly. Keep them lined up:

- **`entities/` are queries.** One slice per domain entity: its read-model
  display components and a `useBuildingStatus()`-shaped hook wrapping the
  service's query. Read models arrive as value objects and are rendered to
  primitives at the leaf.
- **`features/` are commands.** One slice per *user interaction*, named for the
  interaction and not for the entity: `submit-report`, not `report`. Holds the
  form, the validation, and a `useSubmitReport()`-shaped hook wrapping the
  service's command. **A write returns an Ack, never data** — whatever the
  screen should show afterwards, it asks a query for, which in practice means
  invalidating the entity's query key.

A feature may import an entity. An entity may never import a feature — that is
Law 1, and it is also just the read side not depending on the write side.

## The one door

Everything network lives under `src/ui/shared/api/`, and
`bounded-ts-web/client-one-door` refuses a runtime `@trpc/*` or `@tanstack/*`
import anywhere else (`import type` is fine everywhere).

```ts
// src/ui/entities/building/model/query.ts
import { useQuery } from "...";            // ← BLOCKED. Not here.
```

```ts
// src/ui/entities/building/model/query.ts — the correct shape
import { useServiceClient } from "../../../shared/api/client.js";

export function useBuildingStatus(id: BuildingId): BuildingStatusResult {
  const client = useServiceClient();
  /* wrap the client call in the query hook the door re-exports */
}
```

One client, one URL, one `QueryClient`. A second client is a second URL to get
wrong; a second `QueryClient` splits the cache and *nothing fails* — half the
app quietly stops seeing the other half's writes. Reading the client from
context is also what makes a component testable: render it under a provider
holding a fake and it knows no difference.

## Spec discipline: write for a test-writer who cannot see the screen

**This is the part that decides whether the run works.** The test-writer never
sees `src/`, never sees a rendered pixel, and cannot judge whether a layout
"looks right". It writes tests against *observable behaviour*: the roles,
accessible names, labels and visible text a user would use to operate the
screen. So a spec section that says "shows building status nicely" is a section
it cannot test, and it will invent something.

State what is on the screen and what changes:

> **Inspection queue count.** The dashboard shows a heading "Inspection queue"
> and, beneath it, the number of buildings with at least one excluded meter.
> With none, it shows the text "No inspections due" and no number. Submitting a
> report for a building whose meter is excluded increases the count by one
> without a page reload.

Every noun in that paragraph is findable: a heading by role and name, a number
by its visible text, a state by the text that replaces it. Compare with "the
queue count updates when relevant" — same intent, nothing to assert.

Practical rules:

- **Name every control by what a user reads**, not by a CSS class or a test id:
  the button "Submit report", the field labelled "Meter reading".
- **Say what the empty, loading and error states show.** They are three
  separate screens and the spec owes all three; a test-writer given only the
  happy path writes only the happy path.
- **Say what a write causes**, in user-visible terms ("the row disappears from
  the queue"), never in cache terms.
- The kit helps: `Label` renders a real `<label>` (so `htmlFor` makes
  `getByLabelText` work), `CardTitle` renders a heading, `Button` renders a
  button. Use them and the accessible names exist for free.

**Visual quality has no gate and never will.** Layout, spacing, hierarchy and
taste are carried by the reviewer and by sign-off. Do not mistake a green suite
for a good screen — r24's was perfect and the screen was a text file.

What the pipeline gives you instead of a gate is *pixels*: the driver can run
`node packs/ts-web/scripts/render-screenshot.ts <project>` at wrap, which builds
the app, photographs it, and leaves `.bounded/render/<timestamp>.png` for a human to
look at. Advisory, always — it exits 0 whatever happens, and on a machine with
no browser it prints one "unavailable" line and gets out of the way. It is a
shell command, so it belongs to whoever has a shell, not to the architect's
toolset.

## Component tests run under jsdom — by pragma, per file

The suite's default environment is node (the domain's tests need nothing
else). A test file that RENDERS — anything importing Testing Library — must
declare its environment as its first line:

```ts
// @vitest-environment jsdom
```

jsdom and `@testing-library/react` are pre-installed (pack pins); no config
file is involved, the pragma travels with the file through the red gate's
shadow copy, and a render test without it fails loudly on `document is not
defined` — an environment mistake, not a behaviour finding. **Architect:**
put this rule in the spec's testing notes verbatim; the test-writer cannot
otherwise know it, and one missing line turns a whole file's failures into
noise.

## What the gates enforce

- **contract-purity**: the full rule set, with ONE ratified exemption —
  contracts under `src/ui/shared/ui/` are exempt from `no-naked-primitives`,
  `value-object-shape` and `value-object-documented`, because a Button's
  `label: string` is a string. Everywhere else — including `entities/` and
  `features/` — value objects stand. Moving a domain type into `shared/ui` to
  duck a block does not work: Law 1 refuses the import that made it useful.
- **lint-src** over `.ts` *and* `.tsx`: the four escape hatches
  (`no-non-null-assertion`, `consistent-type-assertions`, `no-explicit-any`,
  `ban-ts-comment`) are banned in components exactly as in domain code —
  `props as any` is the same lie about the same type checker — plus
  `fsd-downward-imports`, `fsd-slice-public-api`, `client-one-door` and
  `blessed-stacks-only`.
- **`bounded-ts-web/tokens-only-styling`**, inside `src/ui/**`: no raw
  Tailwind palette (`bg-red-500`, `dark:text-zinc-400`), no hand-written colour
  in brackets (`bg-[#0ea5e9]`, `[color:red]`). Semantic tokens, or
  `bg-[var(--color-…)]`. Sizes in brackets (`w-[42ch]`) are fine — the rule is
  about colour, because colour is what a theme swap has to reach.
- **The scaffolder** emits a `.tsx` skeleton for any contract whose exported
  surface returns a React element, so a component contract produces a file the
  builder can put JSX in.
- **`new-web-app`** blocks if the layout has been hand-edited — except
  `theme.css`, which it never touches.
- **`deliver` runs the theme gate** (ADR 2026-033): every required token still
  defined, every declared foreground/background pair at 4.5:1 or better, in the
  light scheme and the dark one. It blocks with the pair and the ratio. The fix
  is always an edit to `theme.css`.
