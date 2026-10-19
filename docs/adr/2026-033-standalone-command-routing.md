# 2026-033: The standalone executable owns its command routing

**Status:** accepted for the first CLI migration slice of issue #67. Amends
[ADR 2026-016](2026-016-cli-app.md) for the standalone distribution. The
published package's Node CLI remains a separate compatibility entry.

## Context

The compiled executable already runs Claude Code's hook in process and
dispatches project-pinned calls to a verified installed release. Every other
command still fell through to the published package's CLI. That CLI installs
from npm, reads a project `package.json` and hands off through a package
manager. A single executable cannot promise an independent distribution while
that fallback remains.

## Decision

- The executable has an explicit command route before any legacy CLI import.
  `--version` reports its embedded version and `hook claude-code` keeps the
  in-process host path. `init` enters a standalone setup path. `update`,
  `check`, `host pi`, `catalog build` and unknown commands refuse until each
  has a local implementation. An unsupported command cannot run the npm CLI
  or a package manager.
- `init` first checks the executable's adjacent `release.json` identity. A
  missing, linked, malformed or mismatched identity is a refusal. No
  executable-carried host installer is ready in this slice, so a requested
  host is named as unavailable. No configuration, version pin or hook is
  written. Later host slices add actual installers before enabling setup.
- The published `dist/cli.js` keeps its existing Node and package-manager
  behavior. Its tests remain valid for that entry point. The standalone
  release never imports it as a fallback.

## Consequences

The compiled archive can be tested in a Python project without
`package.json`, Node, npm or Bun on `PATH`. Its currently unsupported setup
commands refuse before changing project files. Before a later slice enables
init, it must locate a verified installed release and use a real host
installer. This slice checks only the adjacent identity's shape and version;
it never treats a fixture installer as user-visible setup.
