---
number: TN-26-005
title: Pack composition — sockets in the core, contributions from packs
kind: design
status: draft
issue: (pending)
---

# Pack composition

The harness will be huge: many packs, and at **project initiation** the
harness is composed into the simplest form that project needs. Most packs
sit installed but uncomposed for any given project, so the architecture rule
is:

**The core owns mechanisms (sockets); packs own content (contributions).
Nothing in the core names a technology, and no pack depends on another
implicitly — only declared pack→pack dependencies exist (ts-api depends on
ts; nothing depends on ts-api by accident).**

## The socket kinds (all already exist as mechanisms)

| socket (core) | contribution (pack) | example today |
|---|---|---|
| phase gate's spec noun-check | denylist entries | tRPC pack contributes graphql, apollo, ajv, … |
| contract-purity / lint-src gates | ESLint rules | `no-erased-router`, `zod-backed-parse` (correctly pack-homed already) |
| scaffolder sync | emitted artifacts keyed on contract content | `service-runtime.ts` shipped on import |
| law generator | generated test families | round-trip law on `toJSON` |
| deliver | dependency pins keyed on tree content | zod / @trpc/server pins |
| skill loading | skills with ask-shaped triggers | `ts-api-service` |

## The violation this note fixes

The spec tech-noun denylist was hard-coded in `agent/src/phase-gate.ts` —
core code naming graphql and fastify. It moves to a **pack contribution
file** (`packs/<pack>/contrib.json`), and the core merges the contributions
of installed packs at evidence-gathering time. A project composed without
the ts pack gets no TS-flavoured nouns; the mechanism (Intake section +
nouns-outside-Intake refusal, ADR 2026-032) stays core and content-free.

## Rules going forward

- **The socket vocabulary is closed and curated** — this is where the model
  deliberately departs from VS Code. There, extensions consume each other's
  points at runtime, so an open vocabulary pays; here a socket only exists
  where gate or generator machinery consumes it, so a socket is born together
  with its consumer, as core or foundational-pack design work with its own
  ADR. Ordinary packs (ts-web, file-handling, data-table, …) are
  **contribution-only**: they never define sockets, and the registry's owner
  typing makes that a compile-time fact, not a review convention. This is
  today's policy, not a forever-law: the mechanism is deliberately the open
  one (any pack CAN own sockets, typed identically), so opening the
  vocabulary later — say for third-party or community packs — is a policy
  change with zero rework, not a redesign.
- A pack adds capability **only** through the sockets above; a pack that
  needs a new socket kind proposes it as core work first (its own ADR).
- Cross-pack references in core guidance (the developer-stage skill naming
  `ts-api-service`) are tolerated while packs are few; the composed form of
  this is skills contributed with routing triggers, so the core skill names
  no pack. Revisit when a second language pack exists.
- Composition-at-initiation (choosing which installed packs a project
  composes, and materializing only their pins/skills/rules) is future work —
  today every installed pack is active. The contribution mechanism is
  designed so that switch is a filter over contributions, not a rewrite.

## Maturation: the VS Code-shaped model (2026-09-16)

VS Code's contribution-point mechanism is the adult form of this design, and
three of its properties are adopted as the maturation path (pi's own package
mechanism — `pi install`, pinned, recorded in `settings.json` — is the
delivery vehicle, per the user's pi.dev pointer):

1. **Typed manifests.** `contrib.json` gains a validated schema the moment
   Phase B gives ts-web real content — a contribution the host can read and
   check without executing pack code.
2. **Two-level sockets.** The core owns only language-agnostic sockets;
   a pack may define sockets of its own for its family. Concretely: "ESLint
   rules" becomes a socket the **ts pack** defines, and ts-web contributes
   its FSD directional lints there — the core never learns ESLint exists.
   Pack→pack contributions ride the same declared `dependsOnPacks` edge.
3. **Composition = the project's `.pi/settings.json`.** The record of which
   packs a project composes is pi's existing package list, not a new
   invention; contribution merging filters by it. This closes the
   "project-initiation UX" question below.

**The socket layer's implementation shape (2026-09-16).** Phase B1 builds a
small typed registry, from scratch, in this repo's own style: extension
points carry their value type and their owning pack as phantom types, so a
wrong-shaped contribution — or a contribution to a pack not declared in
`dependsOnPacks` — is a compile error backed by a runtime check;
contribution surfaces are declared up front; each point may carry a
validation hook; registration is dependency-ordered with cycle detection.
Code-bearing contributions (ESLint rules, law generators) ride the
registry; `contrib.json` remains the data-only layer for contributions that
must be readable without executing pack code (intake nouns) and the
composition record's shape.

**Landed (Phase B0).** `agent/src/socket-registry.ts` is the registry; it
contains no word for ESLint, React or tRPC and must never gain one. The ts pack
defines two sockets in `packs/ts/pack.ts` — `lintSrcRules` (extra rules for the
src gate, each naming the role brief that must mention it) and
`contractPurityOverrides` (extra flat-config blocks, additions and ratified
relaxations alike); `lint-src.ts` and `contract-purity.ts` read them and append.
`packs/installed.ts` is the composition record: a static list plus a memoized
`composedPacks()`, so composition-at-initiation is a second argument at one call
site. A contribution to a socket whose owner is not in `dependsOnPacks` is a
compile error (phantom owner type) and a runtime refusal naming the missing
edge; edges are NOT transitive, which the suite pins in both directions. ts-web
defines nothing — the closed-vocabulary policy above, pinned by a test over the
installed list rather than left to review.
`guard-doc-drift.test.ts` holds a contributed rule to the same brief obligation
as a built-in (ADR 2026-018), reading the target brief out of the contribution
itself.

Deliberately NOT adopted: VS Code's process isolation and API brokering —
their threat model is untrusted third-party code; ours is first-party packs
whose discipline is zones and gates.

## Open questions

- The contribution manifest's schema and versioning (one `contrib.json` per
  pack today; typed and validated when a second pack lands).
- Whether ESLint rule *registration* should also flow through contrib.json
  (today the ts pack's gates import the ts plugin directly — legal, since
  gate and plugin are the same pack).
- Project-initiation UX: where the "compose these packs" record lives
  (`.pi/settings.json` is the natural home).
