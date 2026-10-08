---
number: TN-26-009
title: Composition is a commitment — each pack obligates its own layer
kind: design
status: draft
issue: 18
---

# Composition is a commitment

## Summary

Composing a pack today makes a capability *available*; it does not make the
run *deliver* it. Dogfood Run 29 (a UI + service + persistence ticket, both
arms passing every gate) exposed the cost: one arm shipped an orphan UI kit
that does not build, the other a working app with no shared backend — both
"green". This note proposes that **each pack contributes obligations that
fire when it is composed**, checked at deliver, through the same
socket/contribution model everything else rides (TN-26-005). A composed pack
that did not produce its required, wired artifacts blocks delivery. The
mechanism already has its first instance — the deliver build-check added
after Run 29 (ADR 2026-033) — and this generalises it. **UI and service are
kept as two separate obligations**, so a legitimate local web app is not
forced to grow a backend; the one policy call left open is whether composing
the web pack should *pull in* the service capability by default.

## Why now — Run 29's evidence

Same non-technical prompt ("a shared street tool-library"), same gates, two
arms, both delivered green — and neither was what "green" implied:

- **DeepSeek arm:** correct domain + a persistence port + a shadcn-style UI
  *kit*, but no `app.tsx`, empty `pages/`, nothing importing the domain.
  `vite build` fails. `npm run check` was green because its scope never
  included the web build.
- **opus arm:** a real, building, interactive, accessible app wired to the
  domain — but **no tRPC service**; persistence is browser-local, and opus
  flagged the gap honestly in the UI copy and the spec. A weaker model
  shipped the gap silently; a stronger one wired the app and was candid about
  what it could not reach.

The lesson is the harness's recurring one: a gap found by running it becomes
a mechanism. "Delivered" must mean the composed layers were actually built
and wired, not merely that the stack was on hand.

## The design

### Composition is a commitment, verified at deliver

A pack, when composed, contributes **obligations** — machine-checkable
statements about artifacts the delivered tree must contain and how they must
be wired. A deliver-time completeness gate walks the composed pack list
(`.bounded/composed-packs.json`) and blocks if any composed pack's obligations
are undischarged. This is the stack-layer analogue of what surface-check does
at the domain layer: it makes "the thing exists and matches its promise"
mechanical rather than hoped-for.

### Contributed like everything else

Obligations ride the existing socket/contribution model (TN-26-005), never a
core special-case. The core owns the *mechanism* (a socket the completeness
gate consumes) and names no technology; each pack owns the *content* (its
obligation checks). The first instance already exists: the deliver-check
socket's `checkScript` (ADR 2026-033, added post-Run-29) lets the `ts` pack
fold a pack-supplied build command into the project's `check` while the word
`vite` lives only in `ts-web`. This note promotes that single hook into a
first-class **obligations** contribution covering existence, wiring and build.

### UI and service are two obligations, decoupled

The sharp design call: do **not** let the UI pack force a service. They are
distinct capabilities with distinct obligations.

- **ts-web (UI) obligates:** a *building* app with at least one
  page/feature that imports the domain — no orphan kit, no non-building
  bootstrap. Mechanically: the import graph `main → app → page → domain
  contract` resolves, and the build passes (the build half already shipped
  post-Run-29).
- **The service capability (tRPC) obligates:** a `ServiceRouter` re-export
  exists and a typed client consumes it. Its *content already exists as
  gates* — `no-erased-router`, `router-type-reexported` (the r23
  silent-forfeit fix, ADR 2026-030), `client-one-door`. Today those
  validate a service *if present*; the obligation turns them into
  *must-be-present-and-typed* when the service capability is composed.

Keeping them separate is what makes the gate honest rather than annoying:
opus's browser-local app is a legitimate architecture, and a gate that
failed it for lacking tRPC would forbid a valid choice. The service is
obligated by composing the *service* capability, not by drawing a screen.

### The completeness gate

At deliver, after the existing checks, the gate:
1. reads the composed pack list;
2. for each composed pack, runs its obligation checks (existence + wiring +
   build/acceptance);
3. blocks delivery, naming the undischarged obligation and the pack that owns
   it, if any fail.

Every check is mechanical (a file exists; an import path resolves; a build
exits zero; a `ServiceRouter` type is re-exported) — never "is this a good
app". The gate proves the composed layers exist, connect and build, and
stops there. Judgment about quality stays with the reviewer and the human.

## Decisions

- **Composition obligates delivery.** A composed pack must discharge its
  obligations or deliver blocks. *Why:* "available but unbuilt/unwired"
  silently ships broken multi-layer work, as Run 29 proved twice.
- **Obligations are a pack contribution, checked by a core-owned
  completeness gate.** *Why:* core stays technology-free; each pack owns what
  "done" means for its layer (TN-26-005); it generalises the existing
  deliver-check socket rather than inventing new machinery.
- **UI and service are separate obligations.** *Why:* a local web app is a
  legitimate architecture; forcing a backend on every UI is over-constraint.
  The service is obligated by composing the service capability.
- **The service obligation's content is the existing router gates.** *Why:*
  `router-type-reexported` et al. already encode "a service must be typed";
  the obligation only adds "…and must exist" when the capability is composed.

- **Default web topology stays DECOUPLED** (owner ruling, 2026-09-23).
  Composing the web pack does **not** pull in the service capability: a
  browser-local web app is a legitimate, delivered architecture, and a
  backend is obligated only when the service capability is explicitly
  composed. *Why:* keeps each obligation local and legal local apps legal;
  the opinionated "web means shared by default" reading was considered and
  rejected — the harness enforces what is composed, not an assumed topology.

- **But composing UI + service TOGETHER obligates the wiring between them.**
  When both are composed, the frontend's single network door
  (`client-one-door`) must be the typed client over *this* service's
  `ServiceRouter` — not a mock, not a different API, not nothing. This is a
  **cross-composition obligation**: neither pack's own obligations require
  it (ts-web alone is happy with a local door; the service alone is happy
  being unconsumed), so it belongs to the pair. Today's gates get part way
  (one door exists; the router is typed) but nothing checks the door points
  at the composed router — that check is the new work this obligation adds.
  A single-arm example of exactly this silent forfeit is r23 (ADR 2026-030),
  at the service-to-service seam; the UI-to-service seam is the same shape.

## Open questions
- **Where "wiring" draws its line.** "A page imports the domain" is the
  minimal mechanical proxy for "assembled". Whether to require more (every
  domain operation reachable from the UI; the persistence port actually
  bound) is deferred until the minimal proxy is measured against a run.
- **How obligations compose across dependency edges.** A pack depends on
  another (ts-web → ts); do obligations inherit, or stay per-pack? Start
  per-pack; revisit if a dependent needs to strengthen a dependency's
  obligation.

## Appendix

- **Evidence:** dogfood Run 29 (both arms; the DeepSeek orphan-kit and the
  opus honest-local-app, `docs/dogfood/runs/run-26-029-*`).
- **Seed already shipped:** the deliver build-check + `checkScript` socket
  (ADR 2026-033 amendment) — instance #1 of a pack obligating its build.
- **Reused content:** the router gates (ADR 2026-030); the pack
  socket/contribution model (TN-26-005); the reference-component TN (26-008),
  which this complements — 26-008 shows the shape to copy, 26-009 forces the
  shape to be delivered.
