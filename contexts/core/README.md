# bounded

Guardrails for AI coding agents. Bounded judges every tool call an agent
makes (Claude Code or pi), before it runs, against the packs a project
selects. A refusal names the rule, the pack that contributed it, and what to
do instead. Every decision is recorded in `.bounded/guard-log.jsonl`. The
path gate pack refuses reads, listings and writes of the paths a project
protects, including those a shell command names, and puts back what a shell
command changed in them.

It runs on Node 22.18 or later, with npm, pnpm, yarn or bun.

## Start

In your project (it needs a `package.json`):

```sh
npx bounded init
```

This adds `bounded` as a devDependency. It writes `bounded.config.ts`,
selecting the path gate, which brings in the core, with default rules that keep agents
off this configuration, `.bounded/`, Claude Code's settings, pi's loader,
Bounded's installed code and git's hooks and config. It installs the hooks of the agent hosts the
project uses (`.claude/`, `.pi/`, or `--host claude-code`, `--host pi`).
Restart (or start) the hosts' sessions afterwards, as `init` says, so they
load the hooks. After `bounded update`, the CLI says, per host, whether
sessions must restart: Claude Code's only when its settings changed, pi's
every time.

Then add your own rules beside the defaults:

```ts
// bounded.config.ts
import { contribution, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";

export default defineConfig({
  packs: [pathGate],
  contributes: [
    contribution(pathGate.points.protectedPaths, [
      // ...init's default rules...
      { match: "secrets/**", deny: ["read", "create", "modify", "delete"], why: "secrets are kept by people", redirect: "Ask a maintainer for the value you need" },
    ]),
  ],
});
```

Run `npx bounded update` to upgrade Bounded and refresh the hooks.

## What it is not

Bounded discourages agents and keeps a record; it is not a security
boundary. An agent running as your user can always get round it. For
enforcement, pair it with your host's operating-system sandbox, such as
Claude Code's sandbox mode. Known ways round it:

- drift does not watch `node_modules` or `.git`, so what a command changes
  there is not put back;
- commands the path gate does not recognise as writing, such as `sed -i`,
  `perl -i`, `node -e` and `python -c`;
- `git config …` and `git -c core.hooksPath=…`, which the path gate sees as
  reads, so they get past the rules on git's hooks and config;
- paths the path gate cannot resolve (variables, globs), which it allows;
- user-level settings outside the project, such as `~/.claude/settings.json`;
- writes delayed into the background, after the tool call is judged;
- drift's snapshots, kept in a state directory the user (and so the agent)
  can write.

## Export paths

A configuration imports `bounded/domain` and the packs it selects, such as
`bounded/path-gate`. The adapter export paths, `bounded/adapters` and
`bounded/path-gate/adapters`, are internal: they serve the hooks for Claude
Code and pi that this package carries and its `bounded` command, and may
change in any release. 3.1.0 deliberately breaks what 3.0.0 published, in a
minor release because 3.0.0 was about an hour old with no users: it replaced
3.0.0's `bounded/adapters/{file-system,in-memory,system}` and
`bounded/path-gate/adapters/{file-system,in-memory,tree-sitter}`, removed
their in-memory doubles and `pathGateInMemory`, and made the clock and
decision-id ports give `DecisionTime` and `DecisionId` (the repository's
ADR 2026-017). 3.2.0, also a minor release by the maintainer's choice,
deliberately breaks the types 3.0.0 and 3.1.0 published: a selection now
brings in every pack its listed packs depend on, so `Config.selectedPacks`
is `Config.listedPacks`, compose-packs' input field `selectedPackIds` is
`listedPackIds`, and `SelectedPacks.packs` holds every selected pack, listed
or brought in, beside the new `listedPacks` (the repository's ADR
2026-018).

## More

The design, the configuration, the packs and the decisions behind them are in
the repository: <https://github.com/bounded-dev/the-bounded-harness>.

MIT licence.
