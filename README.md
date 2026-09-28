# The Bounded Harness

Bounded is a harness for coding agents. It gives an agent a structured way to
turn a request into working software, then checks the result with rules the
agent cannot simply talk past. The model and the agent application can change;
the instructions, workflow, and checks belong to the project.

Bounded currently supports [pi](https://pi.dev) and Claude Code. It uses the
agent you are already running. It does not start or bundle another agent.

## What happens in a Bounded project

1. **Initialize with your agent.** In an empty directory, ask your pi or
   Claude Code agent to “initialize Bounded here.” It runs `bounded init`, asks
   what kind of application you want to build, and follows up on the product
   needs that affect the setup. It chooses the technical capabilities and
   shows the files it will create before applying the plan.
2. **Work through defined roles.** Bounded supplies skills for recurring work
   and subagents for jobs that benefit from separation. In the developer
   workflow, an architect owns the specification and commissions a reviewer,
   a test writer, and a builder. The test writer does not see the builder's
   code; the builder does not see the tests while implementing.
3. **Let the host enforce boundaries.** Bounded connects to each agent host's
   hook layer. The adapter restricts tools and file writes according to the
   active role and phase. A blocked action is recorded; a role cannot advance
   merely by saying the previous step is complete.
4. **Run the same checks everywhere.** Project-local gates check the design,
   contract, tests, implementation, and delivery. The agent, a human at a
   terminal, and CI can run the same gate code. A review must exist before a
   design freezes, and a passing implementation is tied to the failing test
   run that preceded it.

The result is a project that carries its selected harness, instructions,
skills, agent definitions, hooks, and gates in its own repository. A fresh
clone installs its pinned dependencies with
`bash .bounded/harness/scripts/bounded setup`; it does not need the global installer to keep working.

## Why the separation matters

An agent that writes both the test and the code can accidentally grade its
own work. In early [dogfood runs](docs/dogfooding.md), two ordinary runs
independently produced an invariant test that could not fail. Separating the
test writer from the builder prevented that specific failure. Bounded adds
mechanical checks at each handoff so the process does not depend on an agent
remembering every instruction.

The longer-term direction is in [the vision](docs/VISION.md). The developer
workflow is described in [its design note](docs/tn/TN-26-001-developer-stage-pipeline.md).

## Try the local preview

The CLI is packaged locally but has no public one-command install URL yet.
From a harness checkout:

```bash
cd agent
npm ci
npm run publish:local
bounded --version
```

Then open an empty directory (or one containing only `.git/`) in pi or Claude
Code and ask the current agent to initialize Bounded there. The installed
`bounded` command handles initialization and version reporting. The new
project uses its own Bounded commands; for example:

```bash
bash .bounded/harness/scripts/bounded setup
bash .bounded/harness/scripts/bounded gates --list
```

In that project the agent session is the team lead: it opens each work item
with `bounded lead prepare [--new] [ticket-number]` (the `lead_prepare` tool
on pi) and commissions the architect who designs and delivers it.

The project's configuration (package manifest and lockfile, compiler and
test-runner config) is generated from the selected capabilities, and no agent
may edit it. The gates refuse when it differs from what the capabilities
generate. Restore it yourself with
`bash .bounded/harness/scripts/bounded sync-config`.

For a terminal-led setup, `bounded init --interactive` asks for the technical
selection directly.
The initializer refuses an existing project before writing files. Today it
can initialize a TypeScript web application, a backend service, SQLite
persistence with versioned migrations, or a combination of these. It
sets up the structure and toolchain; the agent designs and builds the actual
product afterward. Public CLI distribution and updates to an already
initialized project are future work.

## Explore the project

- [Vision](docs/VISION.md): why the harness is the owned part of the product.
- [Dogfooding](docs/dogfooding.md): observed runs and what the checks caught.
- [Host adapter](agent/hosts/claude-code/README.md): how Bounded connects to an
  agent's hooks.
- [Architecture decisions](ADRs/README.md): short records of design choices.
- [Contributing](docs/contributing.md): development setup, local publishing,
  and repo-only experiment commands.
