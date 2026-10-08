# 2026-040: Initialize a project with a local harness

**Status:** accepted

## Decision

`bounded init` creates a new project in an empty directory, optionally one
containing only `.git/`. The current pi or Claude Code agent may drive its
plan/apply CLI conversation, but the CLI never invokes a model or another
agent. The chosen host is explicit. Shared planning, copying, validation,
versioning and gate logic remain in the core; host adapters only wire their
own project-local discovery and hooks. A committed manifest, selected pack
record and copied harness make the initialized project independent of the
installer and its source checkout. Runtime evidence remains ignored.

## Why

The old `bounded init` configures a machine, and composition is ignored on
clone. Host hooks and role definitions point to the developer's global
harness. These dependencies prevent a new repository from carrying the rules
that built it. An existing product requires a deliberate import workflow,
not silent retrofitting during initialization.

## Consequences

The machine-wide developer installer takes a different command name. Bare
`bounded init` reports choices without blocking an agent shell; apply uses a
reviewed plan and refuses unsupported or nonempty targets before writing.
Selected host resources load from the project after the host's required
restart or trust step. A later `bounded update` can use the manifest's
versions and owned-file hashes; update and Codex support are separate work.
