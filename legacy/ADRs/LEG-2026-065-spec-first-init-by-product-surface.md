# LEG-2026-065: Spec-first initialization by product surface

**Status:** accepted

## Decision

`bounded init` asks for the product spec or requirements first, pasted or as
a file path, instead of "what kind of application". The agent maps the spec
to a fixed vocabulary of product surfaces the core owns: browser UI, desktop
app, AI-assistant tools, scheduled jobs, network API and persistence. Each
pack declares the surfaces it serves in its `contrib.json`
(`productSurfaces`); the core names no technology.

The agent passes its decisions as `--surface <id>` (needed) and
`--without <id>` (declined). Init selects the one installed pack serving each
needed surface and closes the selection over dependencies. The selection is
a set: one canonical dependency-first order (the default stack's, then by
name) whatever order it was given in, and an installation with the same set
is the same installation. A surface the selection already serves counts as
decided. If the user declined it, the result still flags it (`declined:
true`, with the packs that pulled it in), and the guidance tells the agent to
explain that conflict. If any surface a pack offers is still undecided, init
writes nothing and returns that surface's question, so the agent asks only
about what the spec leaves open. A needed surface no pack serves, or more
than one serves without a `--pack` to choose, refuses. `--pack` alone remains
the technical path.

Before the first ticket is prepared, init replaces an installation with a
different selection in place, under the same plan, review and digest flow.
It does so only when every file init created is unchanged and nothing has
been added apart from what the installation's own ignore rules cover, the
host's local files, and `.bounded/` state. Each host adapter declares its
local files (Claude Code: its local settings); the core names none. Ignored
directories (setup output), the harness copy and the setup marker are
deleted, and setup runs again; the plan lists the deleted setup output.
Ignored files (a filled-in `.env`), host local files and other `.bounded/`
state (the guard log, model tiers) are put back. The replaced installation
is copied to `.bounded-replan-backup/` in the project first, and a failure
at any point restores it. If the process dies mid-replace, the next init
refuses and names that folder until the user restores or deletes it.

The team lead may run this re-plan: on Claude Code as the user's own
`bounded init --host claude-code ...` in one plain form, which the full and
bootstrap hooks admit; on pi through the `lead_replan` tool, after setup. The
lead applies a re-plan only after the user explicitly confirms it.

## Why

In the 2026-10-01 dogfood, init chose web and Postgres from "web app for
project management" before it had seen a spec that also asked for desktop,
AI assistants and a scheduled export. The lead could not correct this, and
the user had to clean the tree and initialize again by hand.

## Consequences

Mapping spec text to surfaces stays the agent's judgment; init makes the
completeness of that mapping and the surface-to-pack step deterministic. A
new kind of surface needs a core change. A pack that serves an existing
surface needs only data. Re-planning after setup reinstalls dependencies.
Scanning an existing directory for a spec is out of scope.
