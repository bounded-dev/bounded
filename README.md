# The Bounded Harness

Bounded is a harness for coding agents. It gives an agent a structured way to
turn a request into working software, then checks the result with rules the
agent cannot simply talk past. The model and the agent application can change;
the instructions, workflow, and checks belong to the project.

Bounded currently supports [pi](https://pi.dev) and Claude Code. It uses the
agent you are already running. It does not start or bundle another agent.

## What happens in a Bounded project

1. **Initialize with your agent.** In an empty directory, ask your pi or
   Claude Code agent to “initialize Bounded here.” It runs `bounded init` and
   asks for your product spec or requirements first (pasted, or a file path).
   From the spec it works out where the product is used (a browser, the
   desktop, AI assistants, a scheduled job, other programs, kept data) and
   asks only about what the spec leaves open. It chooses the technical
   capabilities and shows the files it will create before applying the plan.
   Until the first ticket starts, the team lead can re-plan that choice in
   place.
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

## Get started

The CLI is published on npm as [`bounded`](https://www.npmjs.com/package/bounded)
and needs Node.js 22.18 or later. Install it once:

```bash
npm install --global bounded
```

Then open an empty directory (or one containing only `.git/`) in pi or Claude
Code and ask the current agent to initialize Bounded there. The agent runs
`bounded init`, asks for your product spec, and asks only about what the spec
leaves open. To set up from a
terminal without an agent, run `npx bounded init --interactive`.

The new project uses its own Bounded commands; for example:

```bash
bash .bounded/harness/scripts/bounded setup
bash .bounded/harness/scripts/bounded gates --list
```

In that project the agent session is the team lead: it opens each work item
with `bounded lead prepare [--new] [ticket-number]` (the `lead_prepare` tool
on pi) and commissions the architect who designs and delivers it.

The project's configuration (every package manifest, the lockfile, compiler
config) is generated from the selected capabilities and the design, and no
agent may edit it. The gates refuse when it differs from what the
capabilities generate. Restore it yourself with
`bash .bounded/harness/scripts/bounded sync-config`.

The initializer refuses an existing project before writing files. Today it
initializes a TypeScript project built with Bun: a monorepo of bounded
contexts, each split into domain, application and adapter layers, and apps
that host them. The capabilities cover a tRPC API, MCP tools for AI
assistants, AWS Lambda jobs, a web app, an Electron desktop app, and
Postgres persistence through Drizzle; with no selection named, init composes
all of them. It sets up the structure and toolchain; the agent designs and
builds the actual product afterward, and most of the mechanical code is
generated from the contracts the architect writes. Store tests need Docker.
Updating an already initialized project to a newer harness is future work.

## Explore the project

- [Vision](docs/VISION.md): why the harness is the owned part of the product.
- [Dogfooding](docs/dogfooding.md): observed runs and what the checks caught.
- [Host adapter](agent/hosts/claude-code/README.md): how Bounded connects to an
  agent's hooks.
- [Architecture decisions](ADRs/README.md): short records of design choices.
- [Contributing](docs/contributing.md): development setup, local publishing,
  and repo-only experiment commands.

## License

Bounded is released under the [MIT License](LICENSE).
