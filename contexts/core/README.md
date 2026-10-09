# bounded

Guardrails for AI coding agents. Bounded judges every tool call an agent
makes (Claude Code or pi), before it runs, against the packs a project
selects. A refusal names the rule, the pack that contributed it, and what to
do instead. Every decision is recorded in `.bounded/guard-log.jsonl`. The
protected-paths pack refuses reads, listings and writes of the paths a project
protects, including those a shell command names, and puts back what a shell
command changed in them.

It runs on Node 22.18 or later, with npm, pnpm, yarn or bun.

## Start

In your project (it needs a `package.json`):

```sh
npx bounded init
```

This adds `bounded` as a devDependency. It writes `bounded.config.ts`,
selecting the protected-paths pack, which brings in the core, with default rules that keep agents
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
import { protectedPathsPack } from "bounded/protected-paths";

export default defineConfig({
  packs: [protectedPathsPack],
  contributes: [
    contribution(protectedPathsPack.points.protectedPaths, [
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
- commands the protected-paths pack does not recognise as writing, such as `sed -i`,
  `perl -i`, `node -e` and `python -c`;
- `git config …` and `git -c core.hooksPath=…`, which the protected-paths pack sees as
  reads, so they get past the rules on git's hooks and config;
- paths the protected-paths pack cannot resolve (variables, globs), which it allows;
- user-level settings outside the project, such as `~/.claude/settings.json`;
- writes delayed into the background, after the tool call is judged;
- drift's snapshots, kept in a state directory the user (and so the agent)
  can write.

## Export paths

A configuration imports `bounded/domain` and the packs it selects, such as
`bounded/protected-paths` and `bounded/prereqs`. The adapter export paths,
`bounded/adapters`, `bounded/protected-paths/adapters` and
`bounded/prereqs/adapters`, are internal: they serve the hooks for Claude
Code and pi that this package carries and its `bounded` command, and may
change in any release.

3.1.0 deliberately breaks what 3.0.0 published, in a
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
2026-018). It also reads shell commands once, in the core's judge (the
repository's ADR 2026-020): `openProject` requires a `shellCommandReader`,
`pathGatePortProvisions()` gives two provisions, and `bounded/path-gate`
no longer exports `PathKind`, `PathKinds`, `ShellCheck`, `ShellParser`,
`pathKindsPort` or `shellParserPort` (nor its adapters
`TreeSitterShellParser` and `FileSystemPathKinds`). 3.3.0 renames the path
gate the protected-paths pack (the repository's ADR 2026-021):
`bounded/path-gate` and `bounded/path-gate/adapters` are now
`bounded/protected-paths` and `bounded/protected-paths/adapters`, and
`pathGate` and `pathGatePortProvisions` are `protectedPathsPack` and
`protectedPathsPortProvisions`; the old names are removed, with nothing kept
for them.

A host other than the two this package carries opens a project with the
shell command reader bounded publishes:

```ts
import { openProject } from "bounded/open-project";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { TreeSitterShellCommandReader } from "bounded/shell-command-reader";

const shellCommandReader = new TreeSitterShellCommandReader();
const project = await openProject(root, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()], shellCommandReader });
```

Without a reader every shell command is read as unread, and the protected-paths pack
refuses it. A host with a shell of its own may write its own reader of the
core's `ShellCommandReader` port (`bounded/application`); its tests run the
suite every reader runs, `bounded/testing/shell-command-reader-conformance`
(under bun's test runner).

## More

The design, the configuration, the packs and the decisions behind them are in
the repository: <https://github.com/bounded-dev/bounded>.

MIT licence.
