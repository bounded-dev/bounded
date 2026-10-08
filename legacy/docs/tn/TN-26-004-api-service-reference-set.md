---
number: TN-26-004
title: The API-service reference set — one deterministic way to put a component on the wire
kind: design
status: draft
issue: (successor to #14 / Run 22 findings; dedicated ticket pending)
---

# The API-service reference set

Run 22 proved the pipeline can deliver a tRPC service — and proved it by
cheating twice. The prompt carried hand-written expertise (reuse the domain's
parsers, test through the server-side caller), and the one place that
expertise ran out, the architect erased the router's type (`AnyRouter`) and
no gate objected. This note designs the fix as a **reference set**: when a
ticket says "expose this to the frontend" — never naming a framework — the
harness rolls out the *same* service structure every time, deterministically,
serialization included.

## Premise: the ticket names a capability; the harness binds the stack

Users say "the web team needs to call this", not "tRPC v11". Stack choice is
harness policy, not ticket content — the same move as vitest being *the* test
runner. One blessed RPC stack for TypeScript (tRPC today), one blessed schema
engine (zod), both pack-pinned, recorded in an ADR. Three layers make the
binding stick:

1. **Guidance** — a pack skill triggered by capability language ("expose over
   an API / HTTP / RPC / to a frontend / typed client"), naming the house
   stack and the reference structure. Best-effort: a model may fail to load
   it.
2. **Availability** — the pack owns what is installed. Target projects forbid
   adding dependencies, so the only reachable stacks *are* the blessed ones,
   pinned and installed by the harness (the ts-morph pattern in `deliver`:
   pin, install, verify, block on failure). Deterministic even when the skill
   never loads.
3. **Enforcement** — lint rules that apply unconditionally whenever the stack
   is present in the tree, not conditional on anyone having read anything.

**Intake strips the "how" before anything else reads the ticket.** This is
a general rule of the whole developer stage, ratified as ADR 2026-032 —
API services are merely where it first bit: every spec arriving from a user
or a parent agent is reworked into pure requirement language — *what* must
be possible, for *whom*, under *what* rules — and any embedded
implementation choice ("over GraphQL", "as a cron job", "using library X")
is stripped at the door. The architect's spec records what was stripped in
an "Intake" section, so the removal is a visible act rather than a silent
one. Two outcomes follow:

- **The common case: the "how" was incidental.** "Expose the data to the
  frontend over GraphQL" becomes "the frontend needs typed access to the
  data"; the house stack binds as policy and nothing leaks — the delivered
  interface is the reference one, whatever word the ticket used.
- **The rare case: the "how" is a real constraint** ("must plug into the
  company's existing GraphQL gateway"). That is a product decision wearing a
  technology sentence, and the developer stage already routes those: it
  reaches the user (TN-26-001 dispute protocol) instead of being either
  obeyed or dropped.

Enforcement backstops the intake rule mechanically: no non-blessed framework
is installed or installable, and the `blessed-stacks-only` import lint blocks
the leak even if a stripped "how" survives into someone's head. A non-house
stack ships only after a human changes the policy, never because a ticket
mentioned one.

## CQRS at the boundary: every payload is a command or a query

The wire shape is fixed: **every mutation takes exactly one command value
object; every query takes exactly one query value object.** No positional
scalars, no anonymous option bags.

- Commands and queries are value objects like any other — nominal classes,
  private constructor, `static parse` (ADR 2026-015) — named
  `<Verb><Noun>Command` / `<Noun>Query`, declared in their own contract file
  (`src/api/commands.contract.ts`, ADR 2026-026 applies unchanged).
- **Their fields reuse the domain's existing value objects.** A command is
  composition, not re-declaration: `IngestReportCommand` holds a
  `BuildingId`, a `Period`, an `Availability` — never a second definition of
  what a valid building id is. The existing `no-naked-primitives` rule
  already polices the field types; a new shape rule polices the pairing
  (below).
- **Writes never return data.** A mutation's output is an acknowledgement
  only — never a read model; anything the caller wants to see after a write,
  it asks a query for. (r22's `ingestReport` returned the full building
  status; it becomes non-conforming and is brought into line by the first
  pack-era change run.) The exact acknowledgement shape is an open question
  below; that it carries no domain data is decided.
- **Ids are client-produced.** The caller mints entity ids and sends them in
  the command; the system never relies on store-generated ids. This is what
  makes commands replayable and idempotency expressible at the boundary —
  the command names its subject instead of asking the store to invent one.

This gives the boundary one identity per request: the procedure's input type
IS the command, the command IS a value object, and the value object IS the
validator.

## Zod is the engine inside every value object — never a second identity

Refinement of the r22-era stance. Run 22 banned zod because a standalone
schema beside a value object is a dual identity (ADR 2026-023). The precise
rule is narrower: **the value object remains the single public identity; zod
is its internal parsing engine.**

- Every value object's `static parse` is implemented over a zod schema —
  hand-rolled `typeof`-chain validation is the defect, not the schema
  library. Commands compose the schemas of the domain value objects they
  carry, which is exactly the reuse the composition needs.
- The schema never crosses a public surface: no zod type (`ZodType`,
  `z.infer`, a schema constant) on any contract's exported surface. The
  contract declares `parse(raw: unknown): T | undefined` exactly as today;
  that zod sits behind it is invisible to every consumer.
- zod joins the pack-pinned dependency set (installed like ts-morph and
  @trpc/server; version is pack policy).
- The generated value-object law suites are unchanged in role and get
  stronger in reach: hostile-input laws and the wire round-trip law now
  exercise a zod-backed parse the same way they exercised a hand-rolled one.

## Serialization: a law, not a per-run design

Rich domain values do not survive JSON, so the wire form is a property of the
value object itself:

- Every value object exposes `toJSON()` returning exactly the raw shape its
  own `parse` accepts. `JSON.stringify` then serializes nested commands and
  read models natively, and the **round-trip law** `parse(toJSON(v)) ≡ v` is
  generated into the law suite for every value object reachable from an api
  contract — machine-written red/green evidence, identical every run.
- Command parse composes field parses, so one malformed leaf fails the whole
  command with the field path named — which feeds the error taxonomy below.

## The error taxonomy: fixed table, held by composition

Pack-owned, total, closed: malformed payload (command/query parse failure) →
`BAD_REQUEST`; unknown resource → `NOT_FOUND`; violated domain invariant on a
well-formed payload → `UNPROCESSABLE_CONTENT`; duplicate client-minted id on
a `conflict`-declared command → `CONFLICT`; everything else →
`INTERNAL_SERVER_ERROR` carrying nothing.

**Implementation finding (slice E): no per-target probe generator is needed.**
The taxonomy holds by composition of three things that are each already
machine-checked: (1) commands and queries are value objects, so the generated
law suites already feed every one of them the hostile corpus — non-object
bodies, unknown enum names, missing fields all land in `parse → undefined`;
(2) the shipped runtime maps `undefined` to `BAD_REQUEST` before any resolver
runs, and that mapping is pinned by the runtime's own tests in the harness;
(3) the runtime ships byte-identical (scaffolder sync compares against the
canonical copy) and `raw-framework-entry` closes every other door to the
framework. Run 22's two confessed coverage holes are both instances of (1)
and stop existing the moment commands are value objects. What lint cannot
decide — whether an operation is *semantically* a write — stays with the
reviewer; everything downstream of that choice is machinery. (Field-path
detail in `BAD_REQUEST` messages is deferred: it needs a parse-with-issues
door that respects `no-schema-on-surface`; v1 names the command, not the
field.)

## What is gated — the deterministic core

Everything below is a lint rule at contract-purity or a generated test —
enforcement, not advice:

| gate | layer | refuses |
|---|---|---|
| `no-erased-router` | purity lint | `AnyRouter`-style type erasure on a contract surface; message names the re-export-inferred-type pattern (ADR 2026-026 route) |
| `command-query-payloads` | purity lint | an api procedure whose input is not exactly one `*Command` (mutation) / `*Query` (query) value object |
| `no-naked-primitives` (existing) | purity lint | primitive fields inside commands, queries, read models |
| `zod-backed-parse` | zone lint on VO implementations | a value object `parse` with hand-rolled structural validation instead of a zod schema |
| `no-schema-on-surface` | purity lint | any zod type or schema constant exported from a contract |
| `writes-return-ack` | purity lint | a mutation whose declared output is anything but the pack's acknowledgement type — writes never return data |
| `blessed-stacks-only` | zone lint on `src/**` | imports of non-allowlisted API/schema frameworks (graphql, express, fastify, ajv, …) |
| `raw-framework-entry` | zone lint on `src/**` | `initTRPC` (and kin) used anywhere outside the pack-shipped procedure wrapper |
| intake presence | phase gate (existing spec check) | commissioning workers over a `spec.md` with no `## Intake` section |
| tech-noun denylist | purity-layer lint on `spec.md` | stack nouns surviving intake into the spec (curated list, packs contribute) |
| round-trip law | generated test | a value object whose wire form does not parse back to an equal value |
| hostile wire inputs | generated test | a command/query value object accepting any of the hostile corpus (the law suite — covers non-object bodies, unknown names, missing fields) |
| runtime byte-identity | scaffolder sync | a service-runtime.ts differing from the pack's canonical copy (edits do not survive a design_gate) |
| stack pin | deliver step | a tree whose installed @trpc/server or zod differs from the pack pin, or is missing |

Not gateable, and named as such: whether the *exposure design* is right
(which operations, their granularity) — that stays architect judgment plus
the reviewer's challenge, and the CQRS shape rule at least guarantees the
reviewer reads it in one fixed vocabulary.

## Leaning out of steering — the mechanization ledger

Grill follow-up (2026-09-13): the set as first drafted still leaned on
guidance in four places. Determinism over minimalism applies; each gets a
mechanical form, and skills demote to explanation (ADR 2026-018's
bidirectional briefs), never enforcement:

1. **Intake becomes an information-flow boundary, not an instruction.** The
   bulletproof version of how-stripping is the same trick that makes worker
   blindness real: **the architect never sees the raw ticket.** Intake is a
   step the driver runs (deterministically launched, like role binding)
   whose output — the requirement document — is the only text the architect
   session receives; a "how" the architect never read cannot leak into the
   design. Backstops: the phase gate's existing spec check also requires an
   `## Intake` section (trivially deterministic — today it already checks
   size); and a curated technology-noun denylist lint over `spec.md`
   (graphql, express, kafka, …, contributed per pack) catches the crude
   leaks. Residue for judgment: whether a stripped how is a real constraint
   — that escalates to the user, by design, forever.
2. **Structure is emitted, not described.** A `new-api-service` scaffolder
   (precedent: `new-value-object`) generates the reference layout — the api
   contract skeleton with the pack's Ack type, the commands contract file,
   the ports/context wiring, the standalone HTTP entry point, and the
   generated law suites wired in. The skill stops being the thing that
   makes runs identical; the generator is. Residue: which operations exist
   and what they are called.
3. **The error taxonomy becomes a runtime, not a convention.** The pack
   ships one procedure-definition wrapper into the target (the
   surface-check pattern: one file, copied verbatim, pinned) that performs
   the parse→`BAD_REQUEST`, declared-policy→`CONFLICT`/`NOT_FOUND`,
   catch-all→`INTERNAL` mapping mechanically; a lint bans touching the
   framework's raw entry points (`initTRPC`) anywhere but inside that
   wrapper. The taxonomy is then not tested into existence — it is
   structurally impossible to hand-roll. The generated hostile probes stay,
   as proof rather than as the only line of defence.
4. **Value objects start generated, so hand-rolling never begins.**
   `new-value-object` grows the zod-backed template (schema + `parse` +
   `toJSON` + brand) and the law suite comes with it; `zod-backed-parse`
   lint then polices drift, not adoption. Residue: the schema's domain
   judgment — which the generated hostile laws interrogate.

What is left to steering after this is exactly what should be: whether to
expose something at all, what to call it, and whether a stripped "how" was
load-bearing. Everything shape-like is generator + lint + generated test.

## What stays agent, what becomes machine

| concern | today (r22) | reference set |
|---|---|---|
| stack choice | prompt named it | pack policy; contrary tickets challenged, escalated |
| exposure design | architect, freestyle | architect, as commands/queries in one contract |
| payload shape | per-run invention | one command/query VO per procedure, lint-enforced |
| validation engine | hand-rolled parse | zod inside every VO, lint-enforced |
| router typing | erased (`AnyRouter`) | re-exported inferred type; lint-blocked otherwise |
| serialization | undesigned (review blocker) | `toJSON` wire form + generated round-trip law |
| error taxonomy | spec'd per run | fixed table + generated hostile probes |
| framework versions | driver installed ad hoc | pack-pinned, installed and verified |

## Validation

> **Validated (Run 23, 2026-09-14).** Both re-runs delivered green with the
> identical five-file structure and zero expertise in the ticket: the
> GraphQL-worded variant stripped the technology into the Intake section
> (nothing leaked into code), and the one-sentence ticket derived the
> operations from the core's delivered surface. Residue tracked in the run's
> dogfooding entry: router-type re-export is omitted (legal) rather than
> present — consider a rule that requires it; Ack was once re-declared
> structurally instead of re-exported; decomposition width vs mutation
> density stays on the watchlist.

Re-run Run 22's task with (a) the prompt stripped of all smuggled expertise,
(b) the capability phrased without naming any framework, and (c) a variant
ticket that explicitly asks for GraphQL. Pass = identical structure lands
twice, the GraphQL request is challenged and escalated rather than built, no
type erasure, generated laws green, and the review round-trip is spent on the
domain rather than the wire.

## Settled at the grill (2026-09-13)

- **Ack shape:** a minimal receipt — `applied` vs `replayed` — command
  metadata, never domain data. One pack-owned type; `writes-return-ack`
  refuses anything else.
- **No blanket command id.** Idempotency is a domain rule each command's
  spec states (the cockpit's replace-by-(building, period) style). Revisit
  only if a real at-least-once transport arrives; "optional" was rejected
  because nothing optional can be gated.
- **Duplicate-id behaviour is declared per command, machine-readably.** Each
  command's contract carries its policy (`replace` or `conflict`) as a
  static literal the probe generator reads — prose cannot drive generated
  tests. `conflict` commands add a `CONFLICT` row to the error taxonomy;
  either way the declared behaviour gets its generated probe.
- **Two port interfaces over one store from day one** — a read port and a
  write port, same backing store; a lintable shape, and the read side
  becomes swappable for a projection without a contract revision.
- **No grandfathering today.** The only existing trees are disposable
  dogfood arms; rules apply unconditionally from the day the pack ships, and
  the cockpit is simply rebuilt under them in the next run. A
  migration-style change run remains available as an experiment, not an
  obligation. **Live-app migration is deferred, not dismissed:** once the
  harness manages real apps, evolving them through a rule change is its own
  large topic (change-cycle adjacent, TN-26-003) and gets its own note —
  today's statement is about today's empty installed base.

Also settled without a round-trip: the `zod-backed-parse` pairing is
sufficient by construction — lint verifies a schema exists and `parse`
delegates to it, generated hostile laws verify the schema's judgment; that
split of labour is the harness's standard layering, not a compromise. And
detection is belt-and-braces: the developer-stage skill gains one routing
line ("a ticket exposing a component to callers is an api-service ticket —
load the pack skill"), with lint-on-presence as the unconditional backstop.

## Open questions

- The React half stays out of scope: this set keeps the router's type intact
  for a typed client; nothing yet says how a frontend consumes it under the
  pipeline.
