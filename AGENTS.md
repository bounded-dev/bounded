# Agent instructions: the Bounded Harness

This repo **is** the user's live pi config home — `~/.pi/agent` symlinks here.
Every change takes effect immediately for all pi sessions on this machine.

**This is an open-source project.** Write everything in this repository —
docs, comments, commit messages, gate output, ADRs — for a wide audience of
potential users, not for one machine or one person. No private information:
no credentials, no personal paths presented as canon, no context that only
makes sense to the original author. If a note is genuinely machine- or
person-specific, it belongs in an untracked local file, not here.

**Know the destination.** `docs/VISION.md` is the long-term picture this
harness is building toward — the harness as the owned product, guidance
composed in layers (generic → language → stack → domain), enforcement scaling
where prose cannot. Any non-trivial work on the harness should be shaped with
that end state in mind: prefer designs that survive hundreds of layered
rules, not just today's dozens.

## Rules

- **Global scope only.** Never add project-specific config; project
  dependencies belong in that project's `.pi/settings.json`.
- **Root stays language-agnostic.** Language-specific capability lives in
  `packs/<lang>/` as on-demand skills and scaffolders — never in
  `extensions/` or this file (ADR 2026-007).
- **Packages via `pi install npm:<pkg>@<version>`** (or `git:`) — pinned,
  recorded in `settings.json`. Don't hand-edit the `packages` list or touch
  `npm/`/`git/` (ADR 2026-006).
- **Never commit secrets or state.** `auth.json`, `sessions/`,
  `web-search.json` are gitignored — keep them that way.
- **Determinism over minimalism.** The harness is deliberately built so
  agent output has near-zero chance of deviation: prefer compiler, lint,
  tool-allowlist, and gate-script enforcement over prompt instructions,
  and stack enforcement layers even when one looks over-engineered for
  the present workload. Deterministic guardrails are the product, not a
  cost to be justified per-task.
- **Record decisions as ADRs** in `ADRs/` — `YYYY-NNN-slug.md`, very
  concise, scheme in `ADRs/README.md`. Rewrite/compact freely while young.
- **Extensions** — the pi adapter — live in `hosts/pi/extensions/` and
  auto-load on pi session start. Run `npm run check` after editing them.
  `extensions/` at the root is the tool-managed drop zone: untracked runtime
  state installed by external tools — never hand-edit, never commit
  (ADR 2026-006).
- **Canonical project commands.** Projects declare `check` / `test` /
  `build` / `lint`; look for these first in any project (ADR 2026-007).
- **Local CLI publish.** When asked to "publish local", run
  `npm run publish:local` from this worktree's `agent/` directory. This builds
  and installs a snapshot through npm, then checks that `bounded` on PATH is
  that build. Report the `bounded --version` commit and dirty marker. For an
  agent session in another project, check `bounded --version` in that session
  too because its PATH may differ. This does not publish to a registry or
  update projects that already contain a local harness (ADR 2026-041).
- **Repo experiments stay in repo scripts.** Dogfood reset, archive and model
  probes live under `scripts/dogfood/` and are not `bounded` CLI commands or
  part of its npm package (ADR 2026-042).
- **Dogfood prompts are copy-ready.** A `docs/dogfood/*-prompt.md` file holds
  only the prompt text, so the user can select all and paste it. No header
  comment, usage note or run instructions in the file: those go in
  `docs/dogfood/README.md` (enforced by `agent/test/dogfood-prompts.test.ts`).
- **Subagent roster** is minimal: `scout` (read-only), `delegate`
  (write-capable worker), `product-expert` — "the PM" (read-only + web,
  product judgment). Don't add roles ad hoc (ADR 2026-003).

## The extension model — binding for ALL harness work

Everything the harness can do lives in one of two places, and every change
must respect the split (TN-26-005; the socket registry in
`agent/src/socket-registry.ts` and the data layer in `agent/src/pack-contrib.ts`):

- **The core owns mechanisms (sockets), never content.** A socket exists only
  where gate/generator machinery consumes it, is born WITH that consumer via
  an ADR, and no core file may name a technology (no framework names, no
  package names, no type names from any stack). The two prior violations —
  stack nouns hard-coded in the phase gate, React type names in the
  scaffolder — are the pattern to never repeat.
- **Packs own content (contributions), never mechanisms.** Code-bearing
  contributions (lint rules, purity overrides) ride the typed registry:
  sockets carry their owning pack as a phantom type, so contributing across
  an undeclared `dependsOnPacks` edge does not compile. Data-only
  contributions (denylist nouns, component type names, dependency pins,
  project-init scripts) live in the pack's `contrib.json`, readable without
  executing pack code.
- **The socket vocabulary is fixed by policy** (core + foundational packs
  define; ordinary packs contribute only). The mechanism is deliberately the
  open one, so revisiting that policy later costs zero rework.
- **Composition is per project**: a harness host reads the composed pack
  list and merges only those packs' contributions. A pack not composed must
  leave zero trace of behaviour.

If a change requires the core to learn a technology's name, it is in the
wrong layer: move the name into a pack manifest and give the core the socket.

## Working with the user

- **Plain language over internal vocabulary.** The user (and most readers)
  understand the harness's *concepts* but not its mechanical internals. When
  reporting or discussing, describe each mechanism by what it does ("an
  instruction package that loads automatically when the task looks like
  building an API") and attach the internal name only when it is needed for a
  follow-up. Don't lean on terms like pack skill, purity rule, re-freeze, or
  wire-boundary convention as if they are self-explanatory.
- **Durable guidance lives here, not in agent memory.** Do not write Claude
  memories (or any per-agent memory store) for this project — including
  preferences like this one. Anything worth remembering across sessions
  belongs in this file, an ADR, or a TN, where every agent and every human
  reads the same record.

## Issue tracking

All work is tracked in GitHub Issues plus a per-repo board (GitHub Projects
v2). Use the `issue-tracking` skill for anything involving issues, boards, or
work status. Temporary agent working files live in the repo's `.agent-state/`
(gitignored).

For a requirement spanning dependent tickets, use the `team-lead` skill. It
keeps ticket design with each architect and tracks reviewed design handoffs.

> Revisit the issue-tracking skill as the development-workflow (do-work-style)
> port lands — enforcement and worktree conventions belong there, not here.

## Git workflow — trunk-based

- **Independent review before landing.** Every non-trivial harness change
  follows [the harness review workflow](docs/harness-workflow.md): a fresh
  read-only agent or another contributor reviews the final diff, the driver
  resolves findings and records the checks and review evidence. This is a
  working agreement, not an automated merge gate (ADR 2026-038).

- Work happens in worktrees, each on a local branch (created automatically).
- Local branches always track `main`; **"push" means push to remote `main`**
  unless explicitly told otherwise.
- Long-running work pushes to a named remote feature branch only when the
  user explicitly says so.

## Current state

See `README.md` for layout and bootstrap, `ADRs/` for decisions to date.
