---
number: TN-26-011
title: "Dependent tickets: frozen design as a handoff"
kind: design
status: draft
issue: 23
---

# TN-26-011: Dependent tickets — frozen design as a handoff

## Problem

A large requirement may contain several tickets, but a team lead must not
design the shared surfaces between them. Waiting for every producing ticket to
finish wastes the gap between its reviewed design and its implementation. Letting
consumers proceed from an informal promise risks building against a moving
surface. The harness needs a verifiable point at which one ticket's architect
can release another ticket to start.

## Roles and authority

The team lead owns the requirement, acceptance criteria, ticket boundaries,
dependency graph, scheduling, and integration. Each architect owns one ticket's
design and delivery. A consuming architect decides whether a producer's frozen
design answers its needs; it can request a design revision. The team lead never
authors an interface to make two tickets appear independent.

Prefer one larger ticket when two proposed tickets cannot name a stable,
independently useful design handoff. A dependency is an edge between tickets,
not a reason to create a small ticket merely for an interface.

## Handoff protocol

1. The producer architect reaches its existing reviewed design freeze. Its
   stack's gate determines what constitutes a valid design and records the
   frozen artifact set. A passing freeze is distinct from implementation and
   delivery.
2. The producer commits the frozen design at an immutable Git revision. A
   pack-provided publisher checks the local freeze evidence and emits a
   portable receipt: producer ticket, revision, gate identity, and hashes of
   the handed-off files. The receipt travels separately from the ignored
   `.bounded/` run state. The team lead can track these fields without
   interpreting the artifacts. The lead obtains it directly from the
   publisher in the producing gate root; the generic checker proves byte
   consistency, not the provenance of an arbitrary receipt file. For the
   current TypeScript stage, the files are `spec.md` and every contract in its
   checksum manifest; changes to other reviewed context are governed by the ordinary design review and
   integration checks, not by this cross-ticket receipt.
3. The consumer architect reads the frozen design from that exact revision and
   either accepts it as sufficient for its ticket or reports a concrete missing
   decision. This includes checking that a declared dependency can actually be
   resolved and run in the consumer's environment; a type-only import may hide
   a missing runtime entry. A role bound to one project may be unable to read
   a sibling worktree directly; the lead can copy the exact, hash-checked
   handoff files into ignored local state within the consumer's allowed root.
   Copies need neutral extensions while the design gate scans contracts
   project-wide, so they do not become part of the consumer's own freeze.
   Acceptance records the revision consumed. It does not transfer
   design authority from either architect to the team lead.
4. After acceptance, both tickets may implement concurrently in separate
   worktrees. The consumer may verify its own work against a substitute for an
   unfinished producer, but the combined requirement is not complete until
   integration runs against the real output.
5. Before the consumer starts and before each subsequent consumer handoff or
   integration attempt, a check compares the receipt to the committed producer
   revision *and* the producer's current ticket head. A changed, missing, or
   added handed-off file blocks continuation until the producer re-freezes,
   publishes a new receipt, and the consumer reassesses. The lead monitors
   producer revisions between these checkpoints and steers an active consumer
   promptly when a change appears. The producer cannot silently change a
   consumed design.

One producer can have several consumers, and a consumer can depend on several
producers. Cycles indicate a poor ticket split; combine the tightly coupled
work or redesign the boundaries before implementation.

## Worktrees and integration

Each ticket starts from a recorded baseline and has one writing worktree.
Within it, the existing architect/test-writer/builder permissions and gates
apply. The *current* developer stage has one root `spec.md` and scans contracts
project-wide: separate tickets cannot yet have independent freezes in one gate
root. The first trial therefore uses two target projects in one repository,
each with its own gate root. The consumer receives the producer's committed
design as a dependency, not as a second spec in its own gate root. Supporting
two ticket freezes within one target project is a separate prerequisite for
general team-lead mode; this trial must not be reported as proving that case.

The next design step is a ticket-owned artifact set with a stable identifier,
manifest, and lifecycle. Its manifest names the intent, contracts, relevant
decisions, acceptance evidence, and dependency receipts. Gates freeze the
manifest's selected files, so unrelated tickets in one project can advance
independently. The artifact set is durable while the behavior exists and can be
superseded with a link to its successor; it is not a throwaway prompt. A TN
remains appropriate for cross-cutting proposals and decisions, but should not
be required as the format for every ticket. The pack defines the artifact
types and checks; the core should only handle set identity and revision-bound
evidence. The first slice here deliberately retains `spec.md` and does not
claim to solve artifact-set isolation.
Issue #24 tracks that next step.

### Later decision for target projects

ADR 2026-050 replaces the proposed separate artifact-set layout for new target
projects. Each ticket may have one Technical Note named for its issue number;
the note's front matter lists the contracts it owns. The ticket's reviewed
freeze selects that note and those contracts. A ticket that publishes a
dependency needs a TN, while tickets without design work may have none. The
first trial described below remains evidence for the earlier single-spec
stage; it did not test this later arrangement.

A consumer branch can start from a producer's design checkpoint; that
checkpoint is not landed on `main` as unfinished functionality. The integration
owner lands the producer before a consumer that contains its checkpoint. If a
design revision is needed, the producer's architect re-freezes it and the
consumer accepts the new revision before continuing against it.

The team lead integrates completed tickets one at a time against current
`main`, runs the combined project checks, and verifies the parent's acceptance
criteria. A ticket's delivery gate and independent review do not establish
that the combined requirement works. Only the integration owner pushes `main`
and closes the parent issue after that verification.

## First implementation slice

Provide a stack-neutral receipt comparison and consumer acceptance check. The
generic machinery carries identities and compares revisions and bytes; only
a composed stack pack may declare which design gate and artifacts make a
freeze valid.
The TypeScript pack's publisher consumes its existing local gate evidence and
emits the portable receipt. The team lead's guidance consumes those verdicts
and routes failures to the owning architect. The first slice does not need an
autonomous dispatcher, automatic Git merges, or a new agent role. It does not
solve independent ticket freezes inside one gate root.

## Trial and evidence

Use two headless Claude sessions in isolated worktrees for a producing and a
consuming ticket, each with its own gate root in the same repository. Observe a
verified freeze before the consumer starts, overlap of implementation work, a
stale-handoff case, and a final combined check. Claude Code's directly driven
architect session does not currently have the same tool stripping as pi; verify
child role binding and record that enforcement limit instead of treating the
trial as proof of equal host isolation.
Record the starting revision, prompts, relevant gate results, branch heads,
elapsed time, interventions, defects, and limits of the trial. Keep transcripts
and machine-specific paths in `.agent-state/`; publish only generalizable
findings. A dry run tests this coordination path, not its general reliability.

### Two-session trial result

Two headless Claude architect sessions used separate worktrees and gate roots
for a producer readiness signal and a consumer start decision. The producer
froze a contract before implementation. The consumer began design while the
producer's test and build workers ran. Independent review found that the
initial freeze lacked a runnable package path, so the producer architect
revised and refroze its design. The original receipt then blocked as stale;
the new receipt passed and the consumer architect accepted its exact files
after reading a hash-checked local snapshot. A separate simulated producer
change also blocked the old receipt.

Both tickets passed their own red, green, mutation, sign-off, and delivery
gates. The trial branches merged without a source conflict. In the combined
tree, the producer's canonical check passed six tests and the consumer's
passed seven against the real producer implementation; both surface checks
passed. The consumer's implementation did not overlap the producer's because
the missing package promise required re-freezing first. The trial therefore
shows early *design* overlap and a working handoff/revision path, not a
measured speedup from concurrent implementation.

The trial also exposed three limits: the current gate scans copied contracts
inside ignored local state unless those copies use neutral extensions;
the Claude Code child worker trace did not consistently show the same host
binding as the direct architect session; and disposable projects needed
driver-provisioned local tool links because a clean package install was not
verified. No general reliability or same-gate-root claim follows from this
single run.

## Alternatives

- The team lead designs shared surfaces: rejected because it has neither
  ticket design authority nor stack knowledge.
- Every dependency waits for producer delivery: safe but discards the
  contract-first parallel window.
- A separate interface-only ticket or agent role: rejected for the first
  slice; the producer architect already has a reviewed design freeze within
  its normal ticket.
- Merge unfinished design checkpoints to `main`: rejected because trunk is a
  delivered integration surface.
