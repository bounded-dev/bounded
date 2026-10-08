# 2026-041: Install local CLI snapshots through npm

**Status:** accepted

## Decision

Contributors build the CLI tarball from a chosen harness worktree and install
it into npm's global prefix with `npm run publish:local` in `agent/`. The build
embeds the source commit and dirty state. Publishing verifies that `bounded`
on PATH runs that build. Project init records the same provenance.

## Why

An npm global install is the standard distribution layout for a Node CLI. A
tarball is independent of the source worktree; a symlink can silently keep a
project on an older checkout. The resolution check exposes any shadowing
binary before a new project is initialized.

## Consequences

Local publishing is explicit after harness changes. It does not publish to a
registry or update already initialized projects. A public install channel and
project update command remain separate work.
