# Run 21 — the first change run: a delivered tree, evolved through the same gates
r21 is the change cycle's first live outing (ADR 2026-028, TN-26-003, issue
#14), kimi-only (k3 design / k2.7 workers), both halves headless. First a
fresh **baseline**: the cockpit prompt, prompt-to-deliver in one session. Then
the tree was committed, the driver opened the run boundary (`bounded change-run`
archived the guard log; manifest, role and tiers survived), and a **new
architect session** was fed the first change-request prompt
(`heating-cockpit-change-1-prompt.md`): the single 90% availability gate
becomes two thresholds in the versioned set — below 70% to the inspection
queue as before, 70–90% rated but marked reduced-confidence — with the
roll-up exposing whether a building's green rests on thin data, and
inspection entries carrying the availability that excluded them.

| | baseline (greenfield) | change run |
|---|---|---|
| result | GREEN 126/126, delivered headless | GREEN 133/133, delivered (one resume) |
| design | 18m08s, one review cycle | review 5 findings / 0 blockers, re-freeze |
| red | 126 NotImplemented, 0 passed | **133 NotImplemented, 0 passed** |
| mutation | 95%, survivors confessed | 95%, survivors argued equivalent |
| sign-off | 4 findings, 0 blockers | 3 findings, 0 blockers |
| wall clock | 29m32s | not comparable — provider-outage-smeared |

**1. Every run-boundary consequence fired as designed.** The fresh log forced
a fresh review: the change architect's first gated calls were purity on the
*changed* contracts and a reviewer commission — no inherited review, no
inherited red. The re-freeze took the manifest-present path, and the scaffold
step logged `kept src/… (implemented)` for both existing modules: the
non-clobber rule (ADR 2026-023) carrying the old implementation across the
revision. green-requires-red held with no special casing: the standing red
was measured over the revised 133-test tree in the shadow, old tests failing
NotImplemented beside the new ones.

**2. The delta is a design change, not a bolt-on.** The old
`availabilityMinimum` was *replaced* — two thresholds in `ThresholdSet`, a
`MeterConfidence` on every rated verdict, availability on every inspection
entry, `hasReducedConfidence` on the building status, reference set bumped to
v1.1.0. Four files changed (+378/−103), most of it tests. `deliver` applied
**2 steps** — removing the re-generated errors module and the shadow — and
reported everything else already current: barrel, surface check, README,
gitignore. "Ship the delta" turned out to be deliver's existing idempotency
doing its job on a changed tree.

**3. The reviewer earned its round-trip on a diff it never saw as a diff.**
Reading the whole revised design cold, it raised the one deep defect in the
change: `ThresholdSet` permits `availabilityRatableMinimum >=
availabilityFullConfidenceMinimum`, an ordering the spec asserts and no type
enforces. The architect froze over it, and the same invariant resurfaced in
the sign-off as a confessed reliance — the finding travelled the whole run
without being lost. (Review-as-diff, TN-26-003's gap 3, would have made the
reading cheaper; it was not needed for it to be sharp.)

**4. The drift amendment was insurance, not the path.** design_gate's
re-freeze typecheck (worker drift passes, design-owned blocks) never had to
fire: this change was type-additive over the delivered surface — the
conformance blobs are stripped at delivery, so an implementation missing the
new behaviour still compiles until the suite catches it. A signature-breaking
change is the case that needs the amendment; this one proved only the happy
path. Worth a hostile follow-up.

**5. One resume, same playbook as r20.** Fireworks timed out repeatedly
mid-run; the session ground through ~5 hours of retry-and-wait (design
14:02–15:23 including a ~68-minute dead gap, workers 15:58, green 17:54,
mutation 18:11) and finally died two minutes before the driver resumed it
with `pi -c`. The resumed session ran sign_off and deliver — 3 minutes of
actual work. Friction across the whole change run: **1 refusal** (an
architect read of a session file, correctly blocked), iteration 5. Treat
every r21 change-run duration as outage noise, not pipeline cost.

**Artifacts.** Arm repo: baseline at `8afc58d`, change delivered on branch
`run21-change-1`; the arm is reset to the baseline for the next change
experiment. Both guard logs under `.pi/` (the baseline's in
`guard-log-archive/`). Still open, sharpened by this run: review-as-diff, a
signature-breaking change to actually exercise the drift path, and the
red-gate spurious-pass tightening (r21's reds were clean; r20's kimi red was
not).
