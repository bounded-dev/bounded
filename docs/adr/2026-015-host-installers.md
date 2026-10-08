# 2026-015: Host installers are found by package export, outside pack composition

**Status:** accepted.

## Decision

- **Installing into an agent host is distribution, not extension.**
  `bounded init` and `bounded update` (issue #65; the app bounded-cli, [ADR 2026-016](2026-016-cli-app.md)) write a host's hooks or
  loader into a project: `.claude/settings.json` for Claude Code, the loader
  under `.pi/extensions/` for pi. That happens before anything is composed
  and before any decision is made, and it changes no verdict. It is how the
  harness gets into the host, not something the harness does once it is
  running.
- **The core declares the contract; each host adapter package implements
  it.** The application feature `project-setup/init-project` declares
  `HostInstaller` (`{ host, install(projectRoot) }`, idempotent, reporting
  project-relative paths) and the out port `HostInstallerSource`. A host
  adapter package offers its installer as the `hostInstaller` export of its
  `./host-installer` export path. `NodeModulesHostInstallerSource` loads the
  installer of every dependency in the project's `package.json` that has
  that export path. The core names no host, and adding a host needs no
  change to the core.
- **Every installer runs the same conformance suite**,
  `bounded/testing/host-installer-conformance`: it checks the host name,
  project-relative paths, idempotence, and refusal (changing nothing) when
  what it must read cannot be read. The suite is a `bun:test` test-support
  module and does file I/O (its `snapshotFiles` reads the project). Its
  file sits beside the contract in `src/application/` (as every port's
  conformance suite does), which the layer rules allow for test files. Its
  export path is under `testing/`, not `application/`, so no one mistakes it
  for runtime code. It ships in the `bounded` tarball with the rest of
  `src/`, so the host adapter packages can run it. Importing it outside a
  bun test fails, since it imports `bun:test`.

## Why this does not break "one plug-in mechanism"

AGENTS.md says everything extends through packs and extension points, with
no special-case sections, flags or hard-coded exceptions beside them. That
rule governs what the harness *does*: guards, verdicts, lifecycle work,
contributions to a project's composition. A host installer does none of
these. It runs no code at judging time, cannot see a composition, and
contributes to no point. Making it an extension point would mean composing
a project's packs (and so loading its configuration, which `init` has not
written yet) just to find out how to install the hooks that will later load
that configuration. So installing sits outside composition, just as the
host adapters themselves do. They are apps that call `openProject`, not
packs.

The discovery adds no second way to extend the harness's behaviour.
It is the package manager's own convention (a package's export paths) used
for a package-level concern. A pack never offers a host installer, and a
host installer never contributes to a pack.

## Consequences

- A project's set of hosts is its set of installed host adapter packages.
  Installing `bounded-pi` beside `bounded-claude-code` and running
  `bounded update` installs pi's loader too.
- The source refuses rather than guessing when a declared dependency is
  missing from `<root>/node_modules` (an omitted devDependency, or a
  workspace that hoists packages elsewhere), or when a package's
  `./host-installer` does not export a valid installer.
- An installer's answer is untrusted output from another package. The
  source parses it before the core uses it.
- If installation ever needs per-project choices (which hosts, which
  roles), they come from the command line or the host adapter packages, not
  from `bounded.config.ts`. That would be a new decision.
