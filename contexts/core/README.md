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
off this configuration, `.bounded/`, Claude Code's settings, pi's loader and
Bounded's installed code. It installs the hooks of the agent hosts the
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

## More

The design, the configuration, the packs and the decisions behind them are in
the repository: <https://github.com/bounded-dev/the-bounded-harness>.

MIT licence.
