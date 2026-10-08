# Dogfood prompts

Each `*-prompt.md` file in this folder is **only** the prompt text, exactly as
it is pasted into a run, so it can be selected and copied whole. Notes about a
prompt (what it tests, when it was first used, how to run it) live here, never
in the prompt file. A test (`agent/test/dogfood-prompts.test.ts`) refuses a
prompt file that starts with a comment.

Prompts are used verbatim so runs stay comparable: change a prompt's text only
by starting a new file under a new name. (Moving the old header comments here
left every prompt's rendered text unchanged.)

## `clinic-appointments-prompt.md`

The second dogfood prompt for the hexagonal monorepo (issue #39): a clinic's
appointment booking, in a domain unlike the worked example's projects and
notes, so the architect cannot reach a perfect structure by copying the
example's contracts. It has the same shape as `pm-notes-prompt.md`: one
context with two areas (clinicians and appointments); commands and queries
with ordered validation and exact refusal messages, including a
cross-aggregate rule (one appointment per clinician per start time), a
cancel that removes, and a rule that reads the clock (no booking in the
past); a nightly scheduled export with fixed fields; and the browser,
desktop, AI-assistant and scheduled-job surfaces, with data that survives
restarts. Its wording and refusal messages are the clinic's own rather than
pm-notes' templates. What a time is (format, the clinic's single time zone,
opening hours) and every list's order, ties included, are pinned so a run
has no open product question. Product language only (ADR 2026-032): no
framework, runtime, database or file layout is named. First edited in place
after review, before any run used it.

Use it on an arm initialized by `bounded init` with the whole stack
(`scripts/dogfood/reset --init <host> --harnessed docs/dogfood/clinic-appointments-prompt.md`).
After the run, judge the arm against the conventions alone, with no worked
example: `node scripts/dogfood/structure-compare.ts <arm>` (see
`docs/dogfooding.md`). Do not edit the body between runs.

## `heating-cockpit-change-1-prompt.md`

The first CHANGE-REQUEST dogfood prompt (ADR 2026-028, TN-26-003, issue #14).
First used at Run 21, against a tree delivered from
heating-cockpit-ingest-prompt.md by the same arm in the same repository.

It is fed to a NEW architect session after the driver opens the run boundary
(`bounded change-run`): the tree keeps its spec, contracts, implementation, suite
and frozen manifest; the guard log is archived. What is under test is the
change cycle — whether the pipeline can evolve a delivered component through
the same gates, not rebuild it.

Used VERBATIM so change runs across harness versions stay comparable. Do not
edit without starting a new prompt file under a new name.

## `heating-cockpit-ingest-prompt.md`

The heating-cockpit ingest+rating dogfood prompt. First used at Run 17.

Unlike the subscription-billing prompt, this one describes a SLICE OF A REAL
APP — the app-side ingest and rating core of the PKE Heating Cockpit (Bounded /
DiLT Analytics). The thesis under test: the harness gets good enough to
one-shot this slice reliably, run after run. The prompt is therefore the
durable artifact and the app's real starting point; the delivered code is meant
to be kept.

Used VERBATIM so arms across runs stay comparable. Do not edit without starting
a new prompt file under a new name, or every prior run's numbers stop meaning
anything. Copied into each arm as PROMPT.md at setup.

Domain thresholds below are the district-heating reference set from the project
handover and are NORMATIVE — they are the spec, not examples. They are
district-heating-specific by construction: the design must hold them as a
versioned, swappable set (a different heat source needs different numbers),
never as constants scattered through the logic.

## `heating-cockpit-service-graphql-worded-prompt.md`

The TN-26-004 validation prompt (first used at Run 23): a change-request
ticket for a service layer, written the way a real ticket arrives — it NAMES
GRAPHQL, and it carries zero harness expertise. What is under test is the
whole reference set: intake must strip the "how" (ADR 2026-032, the phase
gate refuses a spec naming graphql outside its Intake section), the blessed
stack must bind as policy (ADR 2026-029 — no GraphQL interface may leak),
the scaffolder must ship the service runtime, the payloads must land as
command/query value objects with zod inside (ADR 2026-030/031), and the
write must acknowledge without returning data.

Compare against Run 22, whose prompt hand-fed the stack and the conventions:
if the reference set works, THIS prompt — the ignorant one — must land the
same structure.

Used VERBATIM so validation runs stay comparable. Do not edit without
starting a new prompt file under a new name.

## `heating-cockpit-service-minimal-prompt.md`

The TN-26-004 validation prompt, minimal form (first used at Run 23): the
ticket a busy PM actually writes. One sentence of capability, no operations
enumerated, no technology named, no conventions hinted. Everything else —
the stack, the structure, the payload discipline, the serialization, the
error taxonomy, even which operations the core is worth exposing — must come
from the harness: the skills supply the guidance, the gates enforce it, and
the PM-shaped gaps are the architect's judgment to fill from the core's own
delivered surface.

Compare against the GraphQL-worded variant (same baseline tree): the
reference set passes if BOTH wordings land the same structure.

Used VERBATIM so validation runs stay comparable. Do not edit without
starting a new prompt file under a new name.

## `heating-cockpit-trpc-prompt.md`

The second CHANGE-REQUEST dogfood prompt, and the first STACK one (issue #14;
first used at Run 22). Fed to a new architect session on the tree delivered by
heating-cockpit-change-1-prompt.md, after the driver opens the run boundary.

What is under test, beyond the change cycle itself:
- COMPOSITION, one level up — a second component in the same repository that
  consumes the first only through its delivered public surface.
- STACK FIT — whether the contract discipline (declaration-only contracts,
  parse-based value objects, one identity per value object) survives a real
  framework whose types are inferred rather than declared: tRPC v11.

The driver installs @trpc/server (exact-pinned) before the run; the prompt
deliberately does NOT hand the architect a router-typing recipe — how the
contract expresses a tRPC surface is the design problem being dogfooded.

Used VERBATIM so runs stay comparable. Do not edit without starting a new
prompt file under a new name.

## `heating-status-screen-prompt.md`

The r24 dogfood prompt (TN-26-006 D): the first web-frontend run. A
props-driven screen ticket in product voice — no framework named, no
operations list beyond what a facility manager needs to see, and
deliberately NO backend: the data arrives from the caller, so the run
isolates exactly the new machinery (TSX through the gates, the FSD layers
and their lints, the vendored kit, and blind UI testing against observable
behaviour). The API wiring is r25's change run on this same tree.

Used VERBATIM so runs stay comparable. Do not edit without starting a new
prompt file under a new name.

## `pm-notes-prompt.md`

The dogfood prompt for the hexagonal monorepo rework (ADRs 2026-056 to
2026-064). It describes the worked example's product — projects and notes,
reached from a browser, a desktop app, AI assistants and a scheduled export —
in product language only. Intake strips the how (ADR 2026-032), so this text
names no framework, runtime, database or file layout: the stack must come
from the composed packs, and the structure from the harness's conventions.

Use it on an arm initialized by `bounded init` with the whole stack
(`scripts/dogfood/reset --init <host> --harnessed docs/dogfood/pm-notes-prompt.md`).
After the run, compare the arm with the worked example:
`BOUNDED_EXAMPLE_PROJECT=<example> node scripts/dogfood/structure-compare.ts <arm>`.
Rendered without this comment; do not edit the body between runs.

## `renewable-contracts-prompt.md`

No notes recorded.

## `subscription-billing-guidance-prompt.md`

No notes recorded.

## `subscription-billing-prompt.md`

No notes recorded.

## `tool-library-prompt.md`

No notes recorded.
