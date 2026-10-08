# Configuring a project

A project chooses its packs in `bounded.config.ts` at its root (`.js` and
`.mjs` work too; exactly one must exist).

```ts
// bounded.config.ts
import { contribution, corePack, defineConfig, Verdict, type WriteEffect } from "bounded/domain";

export default defineConfig({
  // The selection: pack objects. corePack must be among them, or every event is refused.
  packs: [corePack],
  // The project's own contributions, to points of the packs it selects.
  contributes: [
    contribution(corePack.points.writeGuards, [
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
import { contribution, corePack, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";

export default defineConfig({
  packs: [corePack, pathGate],
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

The project acts as one more pack, `bounded/project`, that depends on every
selected pack. So its contributions follow the same rules as any pack's: a
contribution to a point of a pack the project does not select does not
compile, and is refused when the packs are composed. The selection must be a
tuple of distinct packs (`[corePack, pathGate]`), not a widened list.

## Opening a project

A host adapter's composition root opens the project once and asks its judge
about every event:

```ts
import { openProject } from "bounded/open-project";

const project = await openProject("/absolute/path/to/project");
if (project.problem !== null) console.error(project.problem);
const verdict = await project.judge(eventFromTheHost);
```

Before judging anything, `openProject` runs what each selected pack
contributes to the core's `onProjectOpen` point, given the project's root and
a way to ask what is at a project path (the path gate loads its shell parser
there). A pack whose preparation fails does not stop the project opening: its
own guards refuse what they cannot check. A host may pass its own
`pathKinds`.

The judge decides each event with the composed packs and records the decision
in `<root>/.bounded/guard-log.jsonl` (see [the decision log](decision-log.md)).
A host may pass its own `configSource`, `log`, `clock` or `recordWithinMs`.

## When the configuration cannot be used

The judge never fails open. If there is no configuration, more than one, one
that throws while loading, one whose default export `defineConfig` did not
make, or one whose packs cannot be composed (for example, a pack whose
dependency is not selected), `problem` says what is wrong and the judge
refuses every event with "This project's configuration cannot be used: …",
recording each refusal. An event the host sends that cannot be read is
refused and recorded with `"event": "invalid"`.

Add `.bounded/` to the project's `.gitignore`.

## Protect the configuration

`bounded.config.ts` runs code inside the process that judges every action, so
it decides what is allowed. The core freezes everything it exports, so a
configuration cannot patch it, but the configuration itself, and every file it
imports, must be protected from the agent: the path gate protects
`bounded.config.*`; files the configuration imports should be protected too
(protecting the whole import closure automatically is planned). The file must
live in the project (a link pointing outside it is refused), and a changed
file is read afresh the next time a project is opened.
