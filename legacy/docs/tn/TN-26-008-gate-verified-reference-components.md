---
number: TN-26-008
title: Gate-verified reference components — what "good" looks like, as code the agent copies
kind: design
status: draft
issue: (pending)
---

# Gate-verified reference components

## Summary

Agents follow a worked example far better than they follow a rule, and the
harness currently gives them the rule. This note proposes a **reference
component**: one complete, deliberately-neutral-domain example — contract,
value objects, tests, implementation — that passes every gate, is **built
through those gates in CI**, and that the skills point an agent at when a
build begins. Its being gate-verified is the whole idea: an example the
gates keep green can never demonstrate something the gates would reject, so
the example and the enforcement cannot drift. Skills reference it by path
rather than inlining it, so the agent reads live source and the skill stays
lean. The recommendation is to build one for `packs/ts` first, tests
included, and measure the drop in gate bounces before deciding whether every
reference set (TN-26-004, TN-26-006) gets its own.

## Why now — the evidence

The dogfood runs show the failure this fixes, and show it is not ambiguity:

- **Idiom-override, not misunderstanding.** `no-branded-aliases` — the ban on
  `type UserId = string & { __brand }` in favour of a nominal class — is the
  most-tripped purity rule, and **opus tripped it 8 times in Run 27** despite
  clear prose. The branded-type pattern is mainstream TypeScript; every model
  reaches for it by training and the rule overrides that prior. Prose loses to
  a prior; an example the model can copy does not.
- **Boundary coverage is a shape you show, not a rule you state.** The red
  gate's boundary-obligations check bounced kimi 23 times and sonnet 5 (Run
  27) — the single largest source of worker iteration. "Cover every boundary"
  is weak as prose; a reference test file that visibly tests every min/max,
  reject case and invariant is a pattern to match.
- **Packaging rules read as arbitrary without an example.** `value-objects-
  own-contract` (one value object per file) tripped kimi 14 times — natural
  grouping instinct versus an unusual layout that a directory of real files
  makes obvious at a glance.

None of this cost final quality — both Run 27 arms delivered 100% mutation
because the gates absorbed the churn — so this is about **cutting iterations
and confusion, not correctness**. The gate remains the enforcement; the
reference is a better index into it than prose.

## The design

### A reference component is gate-verified, or it is a liar

The one non-negotiable: the reference is a real component that CI builds
through the actual gates (contract-purity, red, green, mutation, surface).
A hand-written snippet in a `SKILL.md` drifts from the rules the moment a
rule changes and then teaches the wrong thing silently. A component the
suite keeps green cannot. This also means the reference is not new
machinery — the existing `packs/ts/scripts/testdata/*.contract.ts` +
`*.golden.ts` pairs are already gate-adjacent verified contracts; this
promotes that idea into a first-class, agent-facing artifact.

### Pointed to, never inlined

Skills carry a one-line pointer ("a complete worked example lives at
`packs/ts/reference/…`; read it before writing your first contract"), not a
copy of the code. Two reasons: the agent reads the current, true source
rather than a paraphrase that can rot, and the skill stays lean instead of
swelling with a whole component. This is the user's "ideally not baked into
the skill" instinct, and the drift argument is why it is right.

### Neutral domain, shape not content

The reference lives in a domain unrelated to any likely ticket (a small
ledger, a scheduling primitive — abstract, not "billing" or "contracts"),
and is labelled explicitly: **copy the shape, not the content.** A same-
domain example invites cargo-culting the domain; a neutral one forces the
agent to transfer structure. This mirrors Rocketflare's `example-feature`
plugin — a vendored reference implementation shipped to be read and then
deleted once its shape is understood.

### Tests are the highest-value half

The contract reference kills the branded-alias reach. But the **tests**
reference is worth more, because boundary coverage is where the most
iterations burn and where a shown pattern beats a stated rule most
decisively. A reference test file demonstrates: a nominal value object's
law tests, the boundary matrix (every min/max and reject), the idempotency
/ replay pattern, and one cross-cutting invariant test — the exact shapes
the red gate's obligations check demands.

### Reaching the blind workers

The architect can read the reference at design time. The blind test-writer
and builder are the ones who most need it, and they are commissioned with a
task, not free rein — so the pointer travels in the commission: the
test-writer's brief names the reference *tests*, the builder's names the
reference *implementation*. This keeps the reference on the same rails as
every other instruction and does not widen a blind role's read zone beyond
what it already holds (the reference is inside the harness skill/pack tree,
readable like any skill file — see TN-26-007's `isHarnessSkillRead`).

## Decisions

- **A reference component is CI-gate-verified.** It is built through the
  real gates on every commit; a reference that could go stale is worse than
  no reference. *Why:* an example that drifts from the rules teaches the
  wrong thing silently, the one failure mode a reference must not have.
- **Skills point to the reference; they do not inline it.** *Why:* live
  source cannot rot the way a paraphrase can, and the skill stays lean.
- **The reference is a neutral domain, framed "shape not content."** *Why:*
  a same-domain example is cargo-culted; a neutral one transfers structure.

## Open questions

- **One reference, or one per reference set?** `packs/ts` gets the first,
  covering the core contract + value-object + test shapes. Whether the
  api-service (TN-26-004) and web-frontend (TN-26-006) sets each need their
  own stack-flavoured reference, or a pointer to the core one suffices, is
  deferred until the first one is measured. Resolved by: build one, run the
  dogfood arms, compare gate-bounce counts against Run 27.
- **Read-in-place, or copy-and-delete?** Rocketflare copies its example into
  the tree to be deleted after. The harness's blind separation and disposable
  arms may prefer read-in-place (nothing to clean up, nothing to drift into
  the delivered tree). Resolved by: whichever a worker follows more reliably
  in a run.
- **How much is one component?** A single value object + one operation +
  its tests may teach the shapes with less noise than a full multi-file
  component. Start minimal; grow only if a shape is missed.

## Built (2026-09-22)

The first reference is live at `packs/ts/reference/` — a neutral **reading-log**
domain (`ReadingId`, `Celsius`, and a `record` operation), gate-verified by
`packs/ts/scripts/reference-component.test.ts` on every `npm run check`. What the
build settled of the open questions:

- **How much is one component? — resolved MINIMAL.** Two value objects (one
  string-based, one number-based, so the boundary matrix shows both axes) plus a
  single idempotent operation and its tests. Enough to show every shape the
  evidence named — nominal class, one-VO-per-file, `@accepts` rule, the
  `<Name> — boundaries` block, idempotency/replay, a cross-cutting invariant —
  and no more.
- **Read-in-place vs copy-and-delete — resolved READ-IN-PLACE for workers.** The
  skill and worker briefs point at the reference by path; nothing is copied into
  a delivered tree. The CI driver copies to a throwaway dir only to run the
  running-project gates (red/green/mutation) without dirtying the committed tree
  — an implementation detail of verification, not what a worker does.
- **One reference, or one per set? — still OPEN, as designed.** `packs/ts` has
  its first; whether TN-26-004/006 need their own is deferred until the dogfood
  arms measure the gate-bounce drop against Run 27.

Every gate applies to the reference as to any dogfood arm, so none is stubbed:
`contract-purity`, `surface-check`, the red gate's boundary/reachability
obligations and `value-object-laws` run in-process; the red gate, green gate and
mutation run against the copy. Mutation reports 100% (3 sites, 3 killed) — the
value objects' `equals` and `record`'s idempotency guard.

## Appendix

- **Inspiration:** Rocketflare (`rocketflare-dev/rocketflare`,
  `.claude/skills/` + a vendored `example-feature` plugin "meant to be
  deleted once understood") — a complete reference implementation as the
  teaching surface, not prose rules.
- **Existing assets to build on:** `packs/ts/scripts/testdata/*.contract.ts`
  / `*.golden.ts` (gate-adjacent verified contract fixtures, today used only
  by scaffolder tests); the reference-set TNs 004 and 006; VISION.md, which
  already names "reference implementations" as part of what the harness owns.
- **Evidence:** Run 27 (`docs/dogfood/runs/run-26-027-opus-vs-kimi-both-harnessed.md`)
  purity and red-gate bounce counts; the mechanism-vs-guidance result
  (TN-26-002).
