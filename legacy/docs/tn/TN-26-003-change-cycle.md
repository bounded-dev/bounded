---
number: TN-26-003
title: The change cycle — evolving a delivered component through the developer stage
kind: design
status: draft
issue: (successor to #13; dedicated ticket pending)
---

# The change cycle

The developer stage is greenfield-shaped: empty tree → frozen contract →
blind test-writer + builder → delivered repo. But most real work is **change**
— a spec change to a component that already exists, is delivered, and has
users. The change cycle is running the *same* flow against an existing repo:
edit the contract, have the change challenged, re-establish red, re-green,
ship the delta. This note scopes what already supports that and what is
missing.

It is not hypothetical. Runs 17 and 18 forced the scenario three times: a
harness bug fixed mid-run could not reach the running session (Node caches the
pack module), so recovery meant restarting the arm and hand-reconstructing its
state — an existing frozen, implemented tree that the pipeline had no clean way
to re-enter. Harness-update recovery is a special case of the change cycle, and
the "build the harness with the harness" ambition is change-loop-heavy: it will
hit this constantly.

## What already supports change (built, for free)

- **Non-destructive scaffold (ADR 2026-023).** A changed contract over an
  existing implementation *keeps* the implementation and surfaces the mismatch
  as type errors routed to the builder. This is the core change primitive:
  revise the contract, bring the implementation along.
- **Shadow red.** Red is proven in a freshly regenerated shadow project,
  independent of live `src/` state, so re-establishing red after a change is
  one gate call, not a builder wipe.
- **One round-trip review (ADR 2026-020, amended).** The reviewer challenges
  the design once and holds no authority; the **contract diff** is the natural
  unit to challenge, and the same artifact a human reviews.
- **Green bound to contract + tests hashes.** A changed contract or suite
  re-binds cleanly; a stale red is refused.

> **Partially landed (2026-09-12).** ADR 2026-028 built the entry point: a
> change run is a new run on the same tree, entered by the driver opening the
> **run boundary** (`bounded change-run` archives the guard log; the manifest, role
> and tiers survive), and `design_gate`'s typecheck step now stands over
> worker-owned drift on a re-freeze so the freeze-first order the dispute
> protocol always described is reachable. Gaps 1 (same-machine case) and 2
> (deliver was already idempotent enough to ship a delta) are closed; gap 1's
> fresh-clone adopt, gap 3 (review-as-diff) and gap 4 (knowledge artifacts)
> remain open.

## The gaps a change needs that greenfield does not

1. **Re-baseline entry point.** `deliver` gitignores `.bounded/`, so a delivered
   repo carries *no* frozen manifest. To change it you must first re-freeze the
   existing contracts to establish the drift baseline. There is no "adopt /
   resume an existing project" command — every path assumes an empty tree.
2. **Change delivery.** `deliver` is a first-delivery step (strip scaffolding,
   write the barrel, ship surface-check); a second run is a no-op. "Ship the
   delta" is not a concept.
3. **Review as a diff.** Today the reviewer reads the whole design. For a
   change the reviewable unit is the contract diff — what moved — which is also
   the human review surface (contract-as-review-surface; the Cara engine is the
   candidate host, driven over its CLI, not merged — see the r19 notes).
4. **Knowledge artifacts in the target.** A change needs the *why*: the target
   repo has no ADRs, no `CONTEXT.md`, no captured ubiquitous language. Greenfield
   lacks these too, but change makes them load-bearing — the diff review is only
   as good as the prior decisions it can see.

## Design sketch (one option, to grill)

A `resume`/`adopt` entry that (a) re-freezes the existing contracts to
establish the baseline, then runs the normal loop on the diff: edit contract →
`design_gate` (re-freeze; non-destructive scaffold keeps implementations) →
reviewer challenges the **diff** → red in the shadow → green bound to the new
hashes → a change-aware deliver that ships the delta rather than re-scaffolding
the repo. Harness-update recovery falls out as the trivial case: same tree,
re-enter, continue.

## Open questions

- How does the reviewer see "the diff" versus the whole design, and does a
  human approve the contract diff before the blind workers run?
- Where do target-repo ADRs / `CONTEXT.md` / ubiquitous language live, and who
  writes them — the architect, a new step, or `deliver`?
- How does change-delivery differ from first delivery concretely (barrel merge,
  README section, surface-check already shipped)?
- Does re-baseline need a distinct command, or is it `design_gate` learning to
  freeze an already-implemented tree?
