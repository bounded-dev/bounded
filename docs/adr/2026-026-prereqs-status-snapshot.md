# 2026-026: Optional ports, and the status snapshot `bounded/prereqs` writes for Claude Code

**Status:** accepted (the `prereqs-status` plan, two plan reviews and the
orchestrator's decisions made for the maintainer). Ships in `bounded` 3.3.0,
unreleased, with no version bump of its own. Amends
[ADR 2026-013](2026-013-restructure.md) (a pack's ports, R7's section
order), [ADR 2026-019](2026-019-prereqs-pack.md) (a status read beside the
gate, and its future work) and [ADR 2026-025](2026-025-agent-run-finish.md)
(a second check on `onAgentRunFinish`).

## Context

The maintainer wants a widget in a Claude Code session that shows which
phase the work is in: the project's prerequisite rules in config order, each
with its requirement's status, and the next action that is blocked. The
widget shows and never holds a phase; it re-implements no rule. That widget,
the status band, is item B, recorded in ADR 2026-027, which also records the
installs rejected for it. This ADR is item A: what the band reads.

A Claude Code mod has no Node, so it cannot run bounded's code. The band
reads a file bounded's own hook writes. Every port a pack declares is
required today: a port only Claude Code provides would refuse every pi
project selecting the pack. So the core needs a port a host may provide.

## Decision

### Optional ports (core)

- A pack may declare `optionalPorts` beside `ports`: adapters a host may
  provide. `Composition.requiredPorts()` leaves them out, so `openProject`
  opens without them. They are typed and checked as `ports` are: a pack's own
  keys only, camelCase section keys. A port is declared once: one port under
  a key in each section is refused ("its port '<name>' is declared both
  required and optional"), and so is one port under two keys of one section
  ("the port '<name>' is declared twice: declare each port once"; `ports`
  alone accepted this before, and no shipped pack did it). At compile time,
  a section key in both sections, another pack's key, and a key that is not
  camelCase are refused (`src/test/fixtures/compile-time/rejected.ts`).
- `BasePack` gains `optionalPorts: PortSection` (`definePack` fills `{}`).
  `definePack` returns `DefinedPack<Id, Points, Ports, OptionalPorts>`: a
  `Pack<Id, Points, Ports>`, intersected with its typed `optionalPorts` only
  when it declares any. So the compiler's messages about a pack without
  optional ports name exactly the types they named before; a fourth type
  argument on `Pack` lengthened them past TypeScript's truncation and hid
  the refusal text of a union-typed dependency.
- `Ports.ifProvided(key)` gives `undefined` when the host does not provide
  the port, else exactly what `get` gives. Optional reads go through it, so
  they can be found.
- **The binding rule:** an optional port serves only output that never
  decides a verdict or a record: with or without it, every verdict and every
  record is the same. "A pack declares the ports it reads" stays a
  convention, not an enforced rule: `Ports.get` serves any provided key.
- R7's overview order becomes `id`, `dependsOn`, `points`, `contributes`,
  `ports`, `optionalPorts`.
- **Rejected:** reading a port the pack does not declare. It would hide an
  adapter from the overview.

### The snapshot (pack)

- `PrerequisiteStatusSnapshots`, the pack's optional port
  (`prerequisiteStatusSnapshotsPort`): `now()`, the store's time, parsed as a
  `DecisionTime` (a pack has no clock port), and `save(snapshot)`.
- Two shapes. The value object `PrerequisiteStatusSnapshot` holds no project
  root; its wire form is `PrerequisiteStatusSnapshotJSON`, format
  `bounded-prereqs-status/1`: `read` with `requirements` (one per distinct
  requirement key, in the order rules first name it: key, required agent,
  patterns, status, files matched, and the pending run exactly while
  pending) and `rules` (in contribution order: the contributing pack, the
  rule's own `before` wire form, its requirement key and `allows`); or
  `unread` with `why`. The file form, `PrerequisiteStatusSnapshotFileJSON`,
  adds `projectRoot`; the adapter writes it.
- `allows` is `status === "holds"`: the gate refuses an action a rule comes
  before, or cannot see through, exactly when its requirement does not hold,
  so it is the gate's answer whatever the action's match kind.
- **One shared evaluation.** `before()` and `readRuleStatuses()` go through
  one reading: records read once, the runs still to finish read at most once
  and only when a requirement does not hold by its records, each distinct
  requirement fingerprinted once. `before()` still stops at the first gated
  rule that does not hold, with the same messages. The status read only
  reads.
- **Unread as a whole.** A part that cannot be read (records, runs, files,
  rules) makes the snapshot `unread` with the reason, never per rule: a
  half-read status invites trusting its other lines.
- **Bounds.** `writeStatusSnapshot` takes the store's time first (a time
  that does not parse saves nothing), races the reading against 2000 ms (an
  overrun saves `unread`, "reading the status did not finish within 2000
  ms"), and races the save against 500 ms, abandoned after; a failed save is
  swallowed. **A display-only output never refuses and never delays past its
  bound.**
- **Two checks,** `writeStatusAfterTool` after `recordAfterTool` on
  `afterTool`, and `writeStatusAtFinish` after `recordRunAtFinish` on
  `onAgentRunFinish`. Each does nothing without the port, reports nothing
  and records nothing; when the pack's own ports are missing, the snapshot
  is `unread`, naming them.
- **Every call.** It is written after every finished call and every finish,
  not only after calls that could change watched files: any call can change
  files, and the band's freshness needs one per call. The cost, in Claude
  Code projects selecting the pack: one fingerprint per distinct
  requirement, records and pending runs read once, within 2.5 s.
- **The host precondition.** The port adds up to 2.5 s to each finished call
  and each finish. A host that provides it gives `afterTool` and the finish a
  budget above its other checks plus 2.5 s; Claude Code's 20 s hook deadline
  does.
- **The adapter,** `FileSystemPrerequisiteStatusSnapshots`, writes
  `<root>/.bounded/prereqs/status.json`: a temporary file renamed into
  place; an older reading never replaces a newer one (the kept file's
  `readingStartedAt` is compared first, best effort under concurrent hook
  processes, so the file may be one call behind); temporary files older than
  a minute are swept on save; a failed save removes `status.json`, then
  rejects.
- **Forgeable.** `status.json` is in `.bounded/`, which drift never watches;
  a shell write the protected-paths pack does not see can forge it. It
  decides nothing.
- **Only Claude Code provides the port**
  (`prereqsStatusSnapshotPortProvisions()` in its composition root). pi does
  not, and pays nothing.

## Limits

- The file may be one call behind under concurrent hooks.
- Nothing reads the file until item B lands.

## Consequences

`BasePack` gains a member: a hand-built `BasePack` look-alike must now give
it, but no pack built with `definePack` changes. ADR 2026-019's future work
gains the band (ADR 2026-027). Every host and pack can declare output-only
adapters without making every other host provide them.
