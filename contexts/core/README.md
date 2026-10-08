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
selecting the core and the path gate, with default rules that keep agents
off this configuration, `.bounded/`, Claude Code's settings, pi's loader,
Bounded's installed code and git's hooks and config. It installs the hooks of the agent hosts the
project uses (`.claude/`, `.pi/`, or `--host claude-code`, `--host pi`).
Restart the host's session afterwards.

Then add your own rules beside the defaults:

```ts
// bounded.config.ts
import { contribution, corePack, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";

export default defineConfig({
  packs: [corePack, pathGate],
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
change in any release. In 3.1.0 they replaced 3.0.0's
`bounded/adapters/{file-system,in-memory,system}` and
`bounded/path-gate/adapters/{file-system,in-memory,tree-sitter}`.

## More

The design, the configuration, the packs and the decisions behind them are in
the repository: <https://github.com/bounded-dev/the-bounded-harness>.

MIT licence.
