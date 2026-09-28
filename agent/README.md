# bounded

The CLI for [the Bounded Harness](https://github.com/bounded-dev/the-bounded-harness),
a harness for coding agents. Bounded gives an agent a structured way to turn a
request into working software, then checks the result with rules the agent
cannot simply talk past. It supports [pi](https://pi.dev) and Claude Code, and
uses the agent you are already running.

## Install

Requires Node.js 22.18 or later.

```bash
npm install --global bounded
```

Open an empty directory (or one containing only `.git/`) in pi or Claude Code
and ask the agent to initialize Bounded there. The agent runs `bounded init`
and walks you through product discovery. To set up from a terminal without an
agent:

```bash
npx bounded init --interactive
```

The new project carries its own harness, instructions, agent definitions,
hooks, and gates, and runs its own commands through
`.bounded/harness/scripts/bounded`. `bounded --version` shows the installed
build and the commit it came from.

## Learn more

See the [project README](https://github.com/bounded-dev/the-bounded-harness#readme)
for how a Bounded project works, and
[the vision](https://github.com/bounded-dev/the-bounded-harness/blob/main/docs/VISION.md)
for where it is going.

## License

[MIT](https://github.com/bounded-dev/the-bounded-harness/blob/main/LICENSE)
