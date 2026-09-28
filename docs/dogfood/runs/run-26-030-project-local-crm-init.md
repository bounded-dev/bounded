# Run 30 — project-local init to a small-team CRM (2026-09-24)

This is the first observed run from an empty directory through `bounded init`
into a multi-layer product request. The user described a small-team CRM in
plain language; Claude Code selected the TypeScript, service and web
capabilities, installed the project-local harness, and entered the developer
stage. At the first cutoff, the run was **in progress, not delivered**. This
record first captures the transcripts and guard log through 12:38 UTC, then
adds later observations through final delivery and the next bug investigation.

At the cutoff: 26 frozen contracts, two recorded design reviews, 31 hand-written
test files plus two support modules, and a builder handback reporting 508
passing tests and a clean typecheck. The test-writer made further edits and
reported a clean scoped typecheck. There is **no valid red**, green gate,
mutation result, sign-off or delivery. The latest red gate blocks on three
type errors in its regenerated shadow project.

## The three guard questions

1. **Deterministic corrections.** The design gate blocked a type error at
   11:47:43 UTC and a missing or stale independent review at 11:51:09; the
   architect corrected the design and commissioned reviews. The phase gate
   blocked a second cold builder and test-writer launch at 12:20:13. A
   `run_tests` block reported 471 passing and one failing test at 12:28:21;
   the builder later reported 508 passing. The red gate blocked five times,
   first with four and then with three shadow type errors. The final block at
   12:38:11 still stands. Fifteen path-gate blocks refused wrong-role gates,
   shell commands, protected paths and out-of-zone writes.
2. **Probes and drift.** The architect tried shell listing and a direct write
   under `.bounded/`; both were refused. Reviewers tried shell `ls`/`find`
   rather than their read-only discovery tools, and the builder and test-writer
   each tried shell `ls`; those were refused. The builder tried an
   architect-only surface gate and was refused. These look like tool
   discovery friction rather than evidence of intentional attacks.
3. **Circumvention.** One real bypass occurred. Init had emitted the local
   `bounded` launcher without its executable bit. After a direct protected
   write was refused, the architect staged the launcher with `git add -f`,
   changed its index mode with `git update-index --chmod=+x`, and rewrote the
   protected working-tree file with `git checkout-index -f`. The launcher then
   ran. This was a write through Git into a path the role could not edit
   directly; the path gate did not log the rewrite as a block. The source
   harness now emits an executable launcher and applies a read-only Git
   policy to developer-stage roles (ADR 2026-045). This initialized project
   carries its earlier copy and has not received those fixes.

## What the run taught us

- **The shadow red project cannot model this service contract.** The live
  project typechecks, but the red gate copies contracts and tests while
  omitting the pack-generated `service-runtime` file. The contract also
  exports a router type derived from the real implementation, which the
  shadow intentionally omits. Its three remaining errors are therefore
  produced by the gate's temporary project, not by failing CRM behavior.
  The fix must keep red honest: generated support code can be regenerated
  there, while the router type needs a deliberate typecheck rule for the
  absent implementation. Simply copying the implementation would invalidate
  the red test. Tracked as [issue #25](https://github.com/bounded-dev/the-bounded-harness/issues/25).
- **Background child handoff was unreliable.** The architect launched about
  293 `sleep` calls while waiting for child results, then concluded that the
  workers had produced nothing and handed back. Both had written substantial
  work. The parent session inspected the tree and resumed the architect;
  the architect acknowledged its earlier conclusion was wrong. Future
  Claude Code inits disable background tasks under ADR 2026-045. This run
  remains evidence that an unobserved child is not a failed child.
- **Reviewer discovery lost coverage.** The reviewers recorded 22 findings
  with two blockers and 19 findings with one blocker. They repeatedly tried
  blocked shell discovery, guessed contract paths, and each initially read
  only 25 of the 26 contracts. The second reviewer found the missing file
  after recording its review and corrected its report. A review count alone
  did not prove complete design coverage; the reviewer should get an
  authoritative contract inventory from the gate or task prompt.
- **Product logic ownership needed explicit judgment.** Follow-up status
  (`overdue`, `due today`, `scheduled`, `none`) was classified in a UI slice
  even though it is a business reading of a date. This was spotted by human
  inspection, not by a gate. The source architect/reviewer guidance now asks
  where each rule and finite vocabulary belongs (ADR 2026-049); this
  project's copied guidance predates that change.
- **The test writer had to discover routine safe patterns.** It rewrote
  fixtures to unwrap parsed values and array members without casts, kept
  optional fields truly absent, and changed UI interaction tests to use
  Testing Library events. Its source brief now gives examples of those
  patterns. The builder's late rewrites were mostly code structure and
  contract conformance, not formatting that an auto fixer could handle.
- **Project checks can collect the shadow suite.** The architect observed
  that ordinary Vitest discovery may include `.bounded/shadow-red`, making
  `npm run check` misleading until the project excludes that state tree.
  This has not yet been corrected or verified by a delivery gate in this run.
- **The product scope still has two explicit limits.** The roster is seeded
  but has no add/remove teammate operation, and persistence is a single
  local JSON file without backup or history. These are product decisions to
  revisit before claiming the CRM is suitable for durable shared data.

## Status and follow-up

The harness must repair the red shadow construction, then this project must
re-establish red against the final tests and contracts before green, mutation,
sign-off and delivery. The project-local copy has no update path yet, so a
source fix alone does not unblock this active run. Do not count the builder's
passing suite as a delivered product or treat the five red-gate blocks as five
distinct CRM defects.

## Later observation from the parent session

After the cutoff above, the parent independently ran the live suite and
reported **544 of 545 tests passing**. The one failure is a real sign-out
behavior bug: choosing the control to leave the current teammate's workspace
does not return to roster selection. The parent also found that the project's
ordinary `npm run check` collects the deliberate failures in
`.bounded/shadow-red`, and that delivery chores such as the public barrel
remain undone. The generated `.gitignore` already excludes transient
`.bounded/` state while retaining the project-local harness. No green,
sign-off or delivery verdict had
appeared in the guard log at the time of this update. The parent proposed
finishing outside the gates; that would leave the result without gate
attestation, so it is not recorded here as a completed run.

## Harness repair and project-local retry

The harness repaired the shadow construction under [issue #25](https://github.com/bounded-dev/the-bounded-harness/issues/25). It now regenerates the pack's service support in the temporary red project and handles a forward, type-only reference to an implementation export when the contract and live typecheck establish that export. It still does not copy the business implementation into the shadow. The repaired harness was copied into this project's existing installation while preserving product files and its recorded composition. At 14:21 UTC, the next red-gate run passed the earlier shadow typecheck failure and reached test obligations. This is progress through the same gate, not a red verdict.

That retry exposed two further issues. Thirteen UI exports were reported as unreached even though tests render them with JSX. The TypeScript pack's reachability check parsed those tests as ordinary TypeScript and omitted JSX component references. [Issue #26](https://github.com/bounded-dev/the-bounded-harness/issues/26) corrected the check. After the updated harness was copied into the project, the 14:28 UTC red-gate run reported **zero unreached exports**. It still blocked on **20 boundary obligations**, routed to the test-writer: 19 classes lack a directly asserted accepted literal in their boundary blocks, and `ConversationId` lacks a second rejected literal recognized by the gate. Several existing tests parse through a throwing helper or use computed strings. Those tests exercise behavior, but do not provide the explicit evidence this gate requires. The test-writer brief now explains the direct assertion pattern.

The remaining work must proceed through the test-writer role, then red, green, mutation, sign-off and delivery gates. The earlier sign-out failure and ordinary test discovery of `.bounded/shadow-red` also remain to be resolved and checked through the normal roles. No delivery is claimed by this update.

## Green phase and rule ownership

The test-writer discharged the boundary obligations. At 14:42 UTC,
`red-gate` passed with 545 expected `NotImplemented` failures in its shadow.
The builder fixed sign-out, and the live suite passed 545 of 545 tests with a
clean typecheck. `green-gate` then exposed two conflicts between composed
harness rules: the web pack's client import rule also matched generated
server imports, and the surface checker rejected an exported router value
that the service pack requires and the contract names through an exported
`typeof` alias. [Issue #27](https://github.com/bounded-dev/the-bounded-harness/issues/27)
and ADR 2026-047 record the source repairs. The repaired harness files were
copied into this project without changing product files or gate evidence.
At this cutoff, green has not been rerun against that revision; mutation,
sign-off and delivery remain unverified.

## Final delivery and post-delivery boundary

The resumed gate sequence completed on 24 September. `green-gate` passed with
545 of 545 tests and a clean typecheck. Mutation scoring killed 34 of 40
sampled mutants (85%). Sign-off recorded 11 findings and no blockers. An
initial delivery attempt stopped while locating a dependency version; a later
attempt passed the project check, service and web obligations, theme check,
and production build. Its terminal `deliver: OK` event is the evidence of
delivery, not its earlier per-step pass events. The project check excluded the
red shadow and passed all 545 tests.

A later independent review, using the updated ownership guidance, did identify
the follow-up status issue: the UI decides whether a contact is overdue while
the domain queue also decides when follow-up is due. It called for one domain
decision and a UI-only display mapping. This review came after delivery and
did not alter the delivered verdict, but it is direct evidence that the new
review prompt raised the concern on this design.

The next user-reported issue was a page refresh after pressing an Add control.
The top-level Claude session investigated it without opening a change-run
boundary or binding an architect role. It used unrestricted shell commands,
wrote and removed a temporary test, and ran direct service, web and test
probes. None of this produced a new guard-log event. One command attempted to
append probe data to the live project data file; Claude Code's permission
review denied it, and the session then used a throwaway file. The agent did
not reproduce the browser symptom or make a product fix. These observations
motivate [issue #29](https://github.com/bounded-dev/the-bounded-harness/issues/29):
an unbound top-level session must not silently conduct change work outside
the role and run boundary. [Issue #30](https://github.com/bounded-dev/the-bounded-harness/issues/30)
addresses the separate change-run check that currently treats an intermediate
delivery step as proof of completion.
