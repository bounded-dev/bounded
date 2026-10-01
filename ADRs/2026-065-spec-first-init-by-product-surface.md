# 2026-065: Spec-first initialization by product surface

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
needed surface and closes the selection over dependencies, in the default
stack's order. A surface the selection already serves counts as decided. If
any surface a pack offers is still undecided, init writes nothing and returns
that surface's question, so the agent asks only about what the spec leaves
open. A needed surface no pack serves, or more than one serves without a
`--pack` to choose, refuses. `--pack` alone remains the technical path.

Before the first ticket is prepared, init replaces an installation with a
different selection in place, under the same plan, review and digest flow.
It does so only when every file init created is unchanged and nothing has
been added apart from setup output under the installation's own ignore rules
and `.bounded/` state. Both are removed, and setup runs again. The team lead
may run this re-plan: on Claude Code as the user's own
`bounded init --host claude-code ...` in one plain form, which the full and
bootstrap hooks admit; on pi through the `lead_replan` tool, after setup.

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
