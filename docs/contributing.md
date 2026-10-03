# Contributing to the Bounded Harness

This repository develops the harness and the CLI that initializes a new
project. Work in a Git worktree and read the root `AGENTS.md` before editing.
The product direction is in [VISION.md](VISION.md); design decisions live in
[`ADRs/`](../ADRs/).

## Publish the CLI on your machine

From the `agent/` directory of the harness worktree you want to use:

```bash
npm ci
npm run publish:local
bounded --version
```

`publish:local` builds a tarball and installs it into npm's global prefix. It
checks that the `bounded` on this shell's PATH is the build just installed.
Run it again after a harness change that should affect new projects. Check
`bounded --version` inside any agent session too: its PATH may differ from
your shell. The version output identifies the source commit and marks builds
made with uncommitted changes. Already initialized projects carry their own
snapshot; they do not update when the installer changes.

Local publishing does not send a package to a registry.

## Release to npm

The CLI is published as [`bounded`](https://www.npmjs.com/package/bounded).
From `agent/`, with every change committed:

```bash
npm version patch --no-git-tag-version   # or minor / major
git commit -am "Release bounded <version>"
npm publish
npx bounded@latest --version
```

`npm publish` builds the distribution first, and the published
`bounded --version` reports the commit it was built from. A build with
uncommitted changes is marked `+working-tree`; do not publish one. npm asks
for a browser sign-in to confirm each publish.

## Developer host setup

The repository-only `agent/scripts/bounded-init` command installs development
configuration for the supported agent hosts and runs the harness checks. It
links this checkout into the hosts' machine configuration. That is useful
when developing the harness itself; a consumer project instead gets its own
copy through `bounded init`.

## Dogfood experiments

Experiment commands live in this checkout, outside the distributed CLI:

```bash
scripts/dogfood/reset
scripts/dogfood/archive <run-name> --arm harnessed -m "finding"
```

Read [dogfooding.md](dogfooding.md) before resetting an experiment arm. These
commands can replace experiment directories or archive their results.

## Checks and review

The `agent/` package declares `check`, `test`, and build commands. Harness
changes follow [the development lifecycle](harness-workflow.md): a reviewed
plan, failing tests committed first, and an independent final review for
changes to behavior or architecture. Never commit
credentials, sessions, or experiment state.
