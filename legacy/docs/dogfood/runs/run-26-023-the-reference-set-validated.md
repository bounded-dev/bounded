# Run 23 — the reference set validated: three tickets, one structure
r23 is TN-26-004's validation run, kimi-only, on the reference set built the
same day (ADRs 2026-029..032): a fresh baseline, then two service change
runs on the same delivered tree — one ticket worded "expose the core **over
GraphQL**", one worded in a single sentence ("expose an API for the
frontend") — with **zero harness expertise in any prompt**. r22 had proven
the pipeline could build a service when the prompt hand-fed it the stack and
the conventions; r23 asks whether the harness supplies all of that itself.

**The aborted first attempt earned its keep.** The first baseline try was
stopped and redone, for two findings that were fixes by the same evening:
the developer-stage routing line sent a *domain* ticket to the api pattern
off one sentence of scenery (kimi built an API component nobody asked for),
and the api template imported `Ack` without re-exporting it, leaving the one
type every service test needs unreachable from the test-writer's
contract-limited imports — the reviewer called the jam precisely, and the
architect "solved" it by abandoning the shipped runtime. Also in that
attempt, all firing correctly for the first time in the wild: the ADR
2026-028 drift-tolerant re-freeze (`typecheckDrift: 7 errors, workers`), the
scaffolder pruning the runtime when its import vanished, and an 11-finding
review that caught a genuine spec self-contradiction (the boundary tie-break
rule against its own spread-20K example) which later resurfaced as exactly
the predicted wrong-reason red. Mutation on that oversized tree: 68% — first
evidence that decomposition width and suite density trade off.

| | baseline (redo) | 23a: "over GraphQL" | 23b: one sentence |
|---|---|---|---|
| result | GREEN 149/149, delivered | GREEN 188/188, delivered | GREEN 181/181, delivered |
| clock | **27m29s**, caffeinated | sleep-shredded (2 timeout resumes overnight) | **45m wall**, ~35m active |
| mutation | 88% | 88% | **90%** |
| sign-off | 5 findings, 0 blockers | 4 findings, 0 blockers | 2 findings, 0 blockers |
| shape | domain only — **no src/api** | the reference structure | **the same structure** |

**1. The wording did not matter — which was the whole claim.** Both service
runs landed the identical five-file structure (`commands.contract.ts`,
`commands.ts`, `api.contract.ts`, `api.ts`, the shipped `service-runtime.ts`
marker intact), command/query value objects composing the domain's own
values, writes returning `Promise<Ack>` and nothing else, tests through the
socketless caller. The GraphQL-worded run stripped the technology into the
spec's `## Intake` section — "no GraphQL gateway or schema is in scope" —
and not one occurrence of the word survives in code or tests; the phase
gate stood behind the stripping the entire time. The one-sentence run got
no operations list at all and derived `ingestReport` + `buildingStatus`
from the core's delivered surface itself.

**2. The routing fix held.** The redone baseline, same prompt that caused
the scope creep, built the domain only — four contract files, no api — and
delivered in 27m29s: the stricter rules' steady-state cost over r22's loop
is minutes, not the first attempt's hour.

**3. What the prompts used to carry, the layers now carry — measurably.**
r22's prompt named tRPC, banned zod, prescribed createCaller testing. r23's
prompts named nothing, and every one of those decisions arrived anyway:
policy from the pack (stack pins preinstalled), structure from the
scaffolder (runtime shipped on first import), law from the gates (boundary
pins demanded twice, escape hatches refused, a hand-rolled parse never
shipped — every value object zod-backed). Friction stayed single-digit per
run and every refusal in the logs is a boundary holding, none a jam.

**4. Residue for the conformance ledger.** Neither service contract
re-exports the router's inferred type (legal — `no-erased-router` bans
erasure, not omission — but the typed HTTP client is forgone until a rule
*requires* the re-export); 23b re-declared `Ack` structurally instead of
re-exporting it (compatible, but a second declaration the template says to
avoid); and overnight laptop sleep killed two provider requests mid-run —
`pi -c` recovered both times, but unattended nights need a machine that
stays awake. Add the r23-attempt-1 mutation dip (68% at 11 contracts vs
88–90% at 5–6) to the decomposition-width watchlist.

**Artifacts.** Arm branches: `run23a-graphql-worded`, `run23b-minimal`, both
off baseline `70ae4d5`; the aborted first attempt lives in the auto-archive
(`auto/harnessed-20260913T193716Z`). Per-run guard logs under
`.pi/guard-log-archive/`. The arm rests at the baseline.
