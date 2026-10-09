# Bounded core: extension points and the protected-paths pack

## What this is

A small, standalone library that will become the core of the Bounded harness,
a set of guardrails for coding agents. It is built as its own project and later
brought into the harness repository. It has no user interface, no network API,
no scheduled jobs and keeps no data of its own: other programs (agent-host
adapters and a command-line tool) call it in-process.

It has three parts.

## Part 1: extension points (the core)

The core is as small and pure as possible. It holds only the mechanism by which
packs (selectable bundles of behaviour) extend one another. It holds no opinion
about any application and names no programming language, framework or tool.

- A **pack** has a name, a list of packs it depends on, extension points it
  declares, and contributions it makes.
- An **extension point** is declared by exactly one pack (its owner). It has an
  id, a description, and the type of value it accepts. It may check each
  contributed value and refuse it with a message.
- A pack may contribute only to extension points owned by itself or by a pack
  it lists as a dependency. A contribution across an undeclared dependency must
  be impossible to write (rejected before anything runs) and also refused if it
  reaches composition anyway.
- **Composition** takes the available packs and the packs a project lists
  and produces the composed result. The listed packs and every pack they
  depend on, transitively, are selected; a pack neither listed nor needed by
  a selected pack leaves no trace: its extension points do not exist and its contributions are not
  placed. Reading an extension point returns every contributed value, typed,
  dependencies' contributions before dependents'. The result never depends on
  the order packs were listed in.
- Composition refuses, with a message naming the pack, the extension point and
  the fix: a listed pack that is not available; a pack the selection needs
  that is not available; two different packs with one id in the selection;
  two packs with the same name; an extension point
  declared twice; a pack declaring a point another pack owns; a contribution to
  a point its owner does not declare; an invalid contributed value; and a
  dependency cycle (the message shows the cycle).
- Packs also carry **data contributions**: named fields in a manifest that can
  be read without running any pack code. Reading a field from the selected
  packs returns each pack's value in selection order; a pack without the field
  contributes nothing. A string-list field can be merged across packs into one
  sorted list without duplicates. Reading fails closed: a selected pack whose
  manifest is missing, unreadable or malformed, or that depends on a pack
  that is not available, refuses the read with an actionable message. It is never
  treated as contributing nothing.
- Pack names are lowercase words joined by hyphens; anything else (including
  anything that could reach outside the packs' folder) is refused.

## Part 2: host-neutral events and dispatch (core)

Agent hosts (each coding-agent application) must never know about individual
gates. The core therefore defines a small, host-neutral vocabulary of what an
agent is doing, and a way for packs to subscribe to it.

- **Events.** At least: a tool use (the acting role or none; the action:
  read, write or run; the project-relative paths it touches; the command for
  a run) and a session start (the role). The vocabulary is mechanism, not
  opinion: it names no host, tool or technology.
- **Verdict.** Allow, or refuse with a reason and a redirect.
- **Guards.** For each event the core declares one extension point, the
  guards for that event. A guard is a function from the event (and the
  composed result, so it can read other extension points) to a verdict. Any
  pack may contribute guards; this is the one place the core declares
  extension points of its own.
- **Dispatch.** Given a composed result and an event, run every contributed
  guard for that event in pack order. The first refusal wins and carries its
  reason and redirect; if none refuses, allow. A guard that throws counts as
  a refusal (fail closed) with an actionable reason. With no guards, allow.
- A host adapter translates its own hook call into an event, dispatches, and
  translates the verdict back. It depends on the event vocabulary only, so a
  new gate needs no host change and an unselected gate is never run.

## Part 3: the protected-paths pack (the first pack)

The protected-paths pack (first called the path gate) is a pack, not part of
the core. It decides whether an agent's action on a file path is allowed.

- It declares extension points through which other packs and the project
  contribute path rules: **protected paths**, and **role path rules** (what each
  agent role may read and write).
- A protected-path rule matches project-relative files or patterns, denies
  read, write or both, and supplies a **redirect**: the permitted next step or
  owner (for example "change the generator's input instead"). A refusal is
  never an automatic rewrite or an exception.
- It subscribes to tool-use events by contributing a guard; no host calls it
  by name.
- A decision takes the acting role (or none), the action (read or write) and
  the project-relative path, and returns allow, or refuse with a reason and a
  redirect. The same inputs and rules always give the same decision.
- It applies when no role is active, too. Role rules use the same decision and
  redirect contract.
- Overlapping rules: a denial from any applicable rule wins.
- Protected-path rules are deny-only, and a denial always wins: there are no
  separate allow rules that could override another pack's protection. A rule
  may carry an `except` list of patterns, owned by the same rule, that carve
  paths out of its own `match` (for example match `packages/db/**`, except
  `packages/db/src/schema/**`). An exception never reaches another rule.
- Role path rules are allowlists: a role's read and write zones. The decision
  is: allowed by the active role's zone for that action, if the role has one,
  and not denied by any protected-path rule.
- A path that escapes the project (absolute outside it, or climbing out with
  `..`) is refused.
- Fail closed: a missing or invalid selected rule set refuses every action with
  an actionable error. It never silently disables protection.
- Every decision can be handed to the Bounded log through a port. If the log
  cannot record a refusal, the action is still refused and the result says the
  record was not stored; it never claims a record exists when it does not.
- The decision logic never touches the file system, any agent host or any
  pack's code directly; it receives everything through its inputs and ports.

## Out of scope

Agent-host adapters, the command-line tool, installing into projects, and
rules for any particular language or framework. Those come later and use this
library.
