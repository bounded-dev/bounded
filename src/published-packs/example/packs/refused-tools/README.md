# bounded-example/refused-tools: refuse every tool use of the tool kinds a project lists

The pack of `bounded-example`, the fixture that keeps Bounded's published-pack
slot tested ([ADR 2026-030](../../../../../docs/adr/2026-030-published-packs.md)).
The package is private and never published: it exists so the repository's
tests build, pack and install a published pack beside `bounded`. It ships no
rules of its own: a project contributes them.

## What it is for

Showing a published pack end to end, with nothing a real pack would need: no
library, no port, one point and one guard. A project lists the tool kinds an
agent may not use at all, each with what to do instead, and every tool use of
a listed kind is refused before it runs.

## Rule shape

Projects contribute rules to the pack's one point, `refusedTools`. A rule is:

- `tool`: a tool kind, one of `read`, `search`, `edit`, `write`, `shell`,
  `web`, `subagent` and `other`. Events name what kind of tool acts, never a
  host's own tool name, so a rule naming one (`WebFetch`) is refused: it
  could never match.
- `redirect`: what the agent should do instead, non-empty text.

## Workflows it fits

A session that must stay offline (refuse `web`), one that must not run
commands (refuse `shell`), or one that must not hand work to other agents
(refuse `subagent`).

## What it observes

Each tool use's tool kind, before the call runs, through the core's
`toolUseGuards` point. The first rule whose `tool` is the call's kind refuses
it, naming the pack and the kind, with that rule's redirect.

## What it cannot see

Which host tool the agent used, its arguments, or what it would have done:
only the kind of tool the host adapter reported. A host that reports a tool
under another kind (`other`) is judged by that kind.

## Ports

None: the pack needs no adapter from the host.

## Examples

Each example is a complete `bounded.config.ts`, in `examples/`, with its
scenarios beside it: the calls it judges and the verdict each gets, in
full. The package's tests open each example as a project's configuration
and check every step (`test/example-scenarios.test.ts`), and the package's
catalogue (`bounded.catalog.json`) shows them.

- `refuse-a-tool.config.ts`, with `refuse-a-tool.scenarios.ts`: an offline
  session, pointed at the project's own docs.
