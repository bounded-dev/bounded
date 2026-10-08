---
number: TN-26-010
title: Project-local initialization
kind: design
status: draft
issue: 20
---

# Project-local initialization

## User contract

Install the `bounded` CLI once as a packaged executable independent of a
source checkout. In an empty directory, tell the agent already
running in pi or Claude Code to initialize Bounded. That agent runs `bounded
init`, uses its output to discuss the product and proposed capabilities with
the user, and supplies the answers to the CLI. No Bounded-specific prompt,
skill, second agent, model API call, or global harness checkout is required.
The CLI also works directly in a terminal without an agent. Codex host support
is a separate issue.

`bounded init` creates a new project only. It accepts an empty directory or a
directory containing only `.git/`; other entries cause a clear refusal before
any write. It never reads an existing application as requirements and never
tries to retrofit one. A future import/rebuild workflow needs a separate
command and explicit user intent.

## Conversation and deterministic boundary

Bare `bounded init` prints short, structured, machine-readable guidance that
starts with the product question: “What kind of application are you trying to
build?” It lists host adapters and capability data for the agent to interpret
privately, then exits without writing or waiting for input. The current agent
asks focused follow-ups in ordinary language, infers the complete selection,
and validates it with a plan before proposing installation. It must not expose
pack names as a user menu, silently omit a required capability, or claim a
combination is supported merely because one pack has an initializer. A person
at a shell opts into explicit technical prompts with
`bounded init --interactive`. The apply invocation supplies explicit host,
packs and the digest of the reviewed plan, so an agent shell never hangs on
an interactive prompt. Product intent can inform the agent's proposal,
but the CLI validates the exact selected pack names and dependency closure.
The final plan is shown before writes; unresolved or conflicting answers
block. The agent never has to know hidden installation steps.

The chosen host is **the host already running the agent**. A bare process
cannot reliably identify that host: apply requires an explicit validated
`--host pi` or `--host claude-code` supplied by the current agent or chosen
in the terminal conversation. There is no automatic launch or download of
an agent. Initialization installs only that host's adapter. It must never
silently select a different host. The CLI reports when the current session
must restart or trust project resources before the new adapter takes effect.

## Project artifact

The installer is only a source of bytes during initialization. The initialized
project commits its selected composition, a pinned harness
version and provenance, project instructions, gate code, selected pack code,
host adapter, CLI entry point, dependency manifest and lockfile. Runtime
evidence stays ignored. Host commands and hooks resolve paths relative to the
project, with no absolute path to the developer's harness clone and no
symlink into a home directory. A fresh clone can run its local Bounded
commands and use its chosen agent host after installing declared toolchain
dependencies; it does not require the installer CLI or an external harness
checkout. Project-specific dependencies live in the project's own manifest
and host settings. The core keeps technology names out of its mechanisms.

The project keeps a machine-readable installation manifest with a schema
version, harness release/commit, host, selected packs, and file ownership and
content hashes. This is enough for a later `bounded update` to distinguish
unmodified generated files from user edits; `update` itself is out of scope.
Committed installation files and ignored run evidence must occupy explicitly
separate paths, so an ignore rule cannot erase the composition on clone.
The pack registry in the copied harness is generated for the selected packs;
the current static registry imports every pack and cannot simply be copied
with a subset. Audit runtime imports and dependency pins to establish the
actual copied closure. A clean clone with unselected packs absent is the
proof, including an assertion that omitted packs leave no behavior.

The pi adapter needs project-local extension discovery, project-local skill
and agent definitions, and paths resolved from the project. The current
global loader and role definitions containing `~/.pi/agent` cannot be used
as-is. A clean pi config and the host's project trust/restart behavior are
part of acceptance. The Claude Code adapter needs copied skills and agent
definitions, a project-relative hook in `.claude/settings.json`, and a local
gate command; today's absolute hook path, external skill link and assumption
that `bounded` is on PATH cannot remain.

## Implementation sequence

1. Rename the current machine-wide `bounded init` developer command. Make
   `bounded init` the project initializer. Keep developer bootstrap available
   under an unambiguous name while this repository remains a live config home.
2. Define a plan/apply protocol in the CLI: inspect the directory, list
   supported choices, validate host and pack selection, show a complete file
   plan with a digest, then apply exactly that digest. All inputs, file
   collisions and dependency closure are checked before mutation. Render
   pack init scripts in an isolated staging tree; publish only a complete
   installation. Validation refusals write nothing to the target. A failed
   publish has a defined rollback/recovery path rather than a success claim.
3. Move the composition record to a committed project artifact and make all
   readers use that single source. Keep run state ignored. Existing dogfood
   projects need an explicit migration, not an implicit default.
4. Assemble the project-local harness from the existing core, selected packs,
   skills and selected host adapter. Run each selected pack's declared project
   init script through the existing contribution manifest, not hard-coded
   technology branches in the core. Generate the project's own command entry,
   dependency pins and lockfile. Assembly and application scaffolding are
   separate steps: a selection can initialize a new product only if its
   chosen packs declare enough scaffold commands to produce the required
   project layout and canonical check. Web and service scaffold contributions
   may run together; the CLI must refuse a selection it cannot fully scaffold
   rather than claim to have produced a working project.
5. Wire pi and Claude Code separately through their adapters. Any host API
   limitation that prevents project-local enforcement blocks claiming that
   host is supported; a gates-only fallback must be described as such.
6. Run an initialization check of the copied CLI, selected gates, host
   resources and scaffold integrity. The first product feature creates its
   contracts and implementation, so the application's canonical `check` is
   required at delivery of that feature, not before it exists. Re-running
   init with the same
   selection is idempotent only when a valid installation manifest is present
   and every owned file still has its recorded hash. A different selection,
   changed owned file, or partial prior install refuses with a useful
   explanation rather than overwriting user work. User-created files may
   coexist with a valid installed project on rerun.

## Acceptance

- An agent already running in pi and one already running in Claude Code can
  each drive `bounded init` without loading a Bounded-specific prompt or
  starting another agent.
- Empty directory and `.git/`-only directory succeed with a supported host
  and scaffoldable pack selection; an existing project
  refuses before a write, including before a generated metadata directory.
- The committed project contains only selected capabilities and one host
  adapter. Omitted packs contribute no rules, scripts, skills or dependencies.
- After commit and fresh clone with no global Bounded setup, the local CLI,
  gates and selected host wiring work with declared toolchain dependencies.
- Integration tests exercise the complete initialization, clean-clone local
  command path, and both hosts' project-local discovery. Unit tests cover
  plan validation, refusal, ownership, and rerun behavior.
- Files are reproducible and ownership is recorded. The selected composition
  survives clone; run evidence does not enter Git.
- A clean pi configuration loads the local adapter after any documented
  restart/trust step; a clean Claude Code configuration loads local hooks
  and roles. Neither loads code from a global Bounded directory.
- Init rejects invalid combinations, missing host support, partial installs,
  foreign files and changed generated files without silently weakening gates.

## Deferred

`bounded update`, semantic import of an existing product, and a Codex host
adapter are separate work. The manifest and project-relative paths above are
the compatibility foundation for update.
