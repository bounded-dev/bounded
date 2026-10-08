# Configuring a project

A project chooses its packs in `bounded.config.ts` at its root (`.js` and
`.mjs` work too; exactly one must exist).

```ts
// bounded.config.ts
import { contribution, corePack, defineConfig, Verdict, type WriteEffect } from "bounded/domain";

export default defineConfig({
  // The listed packs. Every pack they depend on is selected with them; corePack must be selected, listed or brought in, or every event is refused.
  packs: [corePack],
  // The project's own contributions, to points of the packs it lists.
  contributes: [
    contribution(corePack.points.effectGuards.write, [
      (effect: WriteEffect) => (effect.path.value.startsWith("generated/") ? Verdict.refuse("generated/ is written by the generator", "Change the generator's input instead") : Verdict.allow),
    ]),
  ],
});
```

Most projects protect paths with the path gate rather than writing guards.
A rule's `deny` names each kind it denies (`read`, `list`, `create`,
`modify`, `delete`); there is no shorthand, so a rule says exactly what it
stops:

```ts
// bounded.config.ts
import { contribution, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";

export default defineConfig({
  packs: [pathGate],
  contributes: [
    contribution(pathGate.points.protectedPaths, [
      {
        match: "generated/**",
        deny: ["create", "modify", "delete"],
        why: "generated/ is written by the generator",
        redirect: "Change the generator's input instead",
      },
      { match: ".env", file: true, deny: ["read", "create", "modify", "delete"], redirect: "Ask a maintainer for the values you need" },
    ]),
  ],
});
```

The selection is the listed packs and every pack they depend on,
transitively ([ADR 2026-018](adr/2026-018-selection-brings-in-dependencies.md)):
the path gate depends on the core, so listing `pathGate` brings `corePack`
in. List a dependency only to contribute to its points.

A project can also require that an action waits for a review: the
prerequisites pack, `bounded/prereqs`, refuses an action until a delegation
to a named agent has succeeded over files that have not changed since
([its README](../contexts/core/src/packs/prereqs/README.md), ADR 2026-019).
It relies on the path gate keeping agents off its records and the agents'
definitions, so list both (each brings in the core), and keep these rules: `bounded init`'s
`.bounded/**`, and the project's agent definitions (`.claude/agents/**` for
Claude Code; pi-subagents' project agent directory for pi):

```ts
// bounded.config.ts
import { contribution, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";
import { prereqs } from "bounded/prereqs";

export default defineConfig({
  packs: [pathGate, prereqs],
  contributes: [
    contribution(pathGate.points.protectedPaths, [
      // ...init's default rules, .bounded/** among them...
      { match: ".claude/agents", deny: ["create", "modify", "delete"], why: "agent definitions say who each agent is", redirect: "Ask a maintainer to change an agent's definition" },
    ]),
    contribution(prereqs.points.rules, [
      { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "Have plan-reviewer review the current plan before editing src/" },
    ]),
  ],
});
```

The project acts as one more pack, `bounded/project`, that depends on every
listed pack. So its contributions follow the same rules as any pack's: a
contribution to a point of a pack the project does not list does not
compile, and is refused when the configuration is used, even when the pack
is brought in by another: list it (`[corePack, pathGate]` to contribute
guards to the core's points). The list must be a tuple of distinct packs,
not a widened list. Two different copies of one pack in the selection (two
copies of a package, say) are refused, naming where each comes from.

## Opening a project

A host adapter's composition root opens the project once and asks its judge
about every event:

```ts
import { openProject } from "bounded/open-project";
import { pathGatePortProvisions } from "bounded/path-gate/adapters";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { TreeSitterShellCommandReader } from "bounded/shell-command-reader";

// The ports the selected packs declare: here every port of the path gate (its files and snapshots on disk)
// and of the prerequisites pack (its fingerprints of the project's files, its records); and the reader of shell commands.
const shellCommandReader = new TreeSitterShellCommandReader();
const project = await openProject("/absolute/path/to/project", { ports: [...pathGatePortProvisions(), ...prereqsPortProvisions()], shellCommandReader });
if (project.problem !== null) console.error(project.problem);
const verdict = await project.judge(eventFromTheHost);
```

Before judging anything, `openProject` runs what each selected pack
contributes to the core's `onProjectOpen` point, given the project's root,
its composition and the ports the host provides, and prepares the shell
command reader alongside (it loads its grammar). A pack, or a reader, whose
preparation fails does not stop the project opening: its own guards refuse
what they cannot check. Every port a selected pack declares must be
provided, or every event is refused, naming the pack, the port and the fix.

The judge reads every shell command first: an execute effect carries the
reading, the programs it runs, the files it reads, lists and writes, and
what only the shell could resolve (ADR 2026-020); a reading the host sent is
replaced. A command that could not be read carries why, and the path gate
refuses it. `shellCommandReader` is required; bounded's own is
`bounded/shell-command-reader`.

The judge decides each event with the composed packs and records the decision
in `<root>/.bounded/guard-log.jsonl` (see [the guard log](guard-log.md)).
A host may pass its own `configSource`, `guardLog`, `clock` or `recordWithinMs`.

## When the configuration cannot be used

The judge never fails open. If there is no configuration, more than one, one
that throws while loading, one whose default export `defineConfig` did not
make, or one whose packs cannot be composed (for example, two different
copies of one pack), `problem` says what is wrong and the judge
refuses every event with "This project's configuration cannot be used: …",
recording each refusal. An event the host sends that cannot be read is
refused and recorded with `"event": "invalid"`.

Add `.bounded/` to the project's `.gitignore`.

## Protect the configuration

`bounded.config.ts` runs code inside the process that judges every action, so
it decides what is allowed. The core freezes everything it exports, so a
configuration cannot patch it, but the configuration itself, and every file it
imports, must be protected from the agent. The path gate ships no rules of
its own; the configuration `bounded init` writes contributes a default rule
protecting `bounded.config.*` (and one protecting `.bounded/`), which a
configuration written by hand should keep (ADR 2026-009). Files the configuration imports should be protected too
(protecting the whole import closure automatically is planned). The file must
live in the project (a link pointing outside it is refused), and a changed
file is read afresh the next time a project is opened.
