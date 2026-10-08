# Vision: the harness is the product

> The long-form argument lives in
> [Everyone Gets Bespoke Software](https://bounded.dev/blog/everyone-gets-bespoke-software/).
> This page is the working summary that day-to-day decisions in this repo
> should be checked against.

## The inversion

Traditionally the running application was the asset and the development
process was overhead. This project bets on the inversion: **the model is a
component you rent; the harness is the part you own.** The harness is
everything between a model and shippable code — steering rules, deterministic
gates, agent role definitions, scaffolders, reference implementations, and
the accumulated knowledge of how one kind of system gets built well. Far
enough up the stack, a harness stops being a general way of building software
and becomes a machine that knows how to build one kind of system, in one
domain. Given the choice between losing a codebase and losing the harness
that built it, keep the harness.

## The tyrannical harness

Models are excellent at creative work and unreliable at consistency. The
answer is not to ask harder — it is to ask *and* architect so the answer
cannot be violated: tool allowlists instead of "please don't", gates instead
of review checklists, the compiler in strictest mode as a gate rather than a
preference. **Knowing which parts of your intent are advisory and which are
enforced is most of the craft.** The evidence base in
[dogfooding.md](./dogfooding.md) exists to keep that split honest: every rule
in this repo that mattered became a mechanism after prose failed, and the
runs that measured prose *succeeding* (frontier models, small rulebooks) are
recorded with their scope stated.

Why this hardens rather than softens as models improve: prose compliance is
paid for out of a model's attention, which is roughly fixed, while the
rulebook grows without bound as the layers below accumulate. Enforcement
scales flat — each gate holds regardless of how many neighbours it has. The
briefs agents read are an index; the gates are the body. (This repo enforces
that relationship itself: a drift test fails the build if a gate is not named
in the brief of the role it binds.)

## No agent owns the harness

The model is a rented component — and so is the agent framework that drives
it. The harness is therefore **agent-agnostic by construction**
([TN-26-007](tn/TN-26-007-agent-agnostic-harness.md), ADR 2026-034).
Everything that judges the tree is one deterministic CLI, `bounded gates` —
the same verdict from CI, a bare shell, or any agent. Everything that shapes
what a role *can do* — tools stripped from the toolset, writes blocked by a
path gate, spawns gated by phase — is a thin per-framework adapter over the
same decision cores, wired through that framework's hook surface. The bar
for a supported host is deterministic enforcement, not cooperation: a
framework that can only be asked nicely can still run the gates, and the
guard log will record that that is all it did.

The harness targets the few key hook-capable frameworks rather than all of
them — pi and Claude Code today, with Codex-class runtimes as candidates —
and **pi is the reference host**: its system prompt is minimal, so the
harness's rulebook is nearly all the model reads, and what is measured in a
dogfood run is the harness rather than a vendor's prompt. Distribution
follows the same grain: the harness ships to each framework as a packaged
extension with a real install; the symlinked config home used today is
developer scaffolding, not the design.

## A many-layered cake

Harnesses compose in layers, each more opinionated than the one below:

1. **Generic development** — design before implementation, independent
   tests, size ceilings, delivery hygiene. Language-agnostic.
2. **Language and technology** — for TypeScript here: contract files,
   nominal value objects, escape-hatch bans, surface conformance.
3. **Stack** — what kind of system is being built: a web app, a task
   processor, a data pipeline; the architecture opinions that follow.
4. **Domain** — knowledge of the business domain being modelled. Not really
   one layer: a domain is usually a stack of them.

Model selection bakes in too: different roles run different models on
purpose, and the harness knows which quality is bought and which is
enforced.

**What exists today is layers 1 and 2** for one language, exercised on one
component. Everything measured so far should be extrapolated with that scope
in mind.

## An assembly kit, not a library

Harness pieces should compose the way shadcn/ui components do: copied into
place and adapted, wired together at assembly time by something intelligent,
rather than imported as versioned dependencies that must integrate on their
own terms. The open problems that follow from this are the interesting ones:

- **Decomposition** — what is the unit of harness? A gate, a rule-set, a
  layer, a pack? What does one look like standing alone?
- **Composition** — how do layers written by different owners stack without
  their rules colliding? (The evidence says rule *interactions* are where
  models find loopholes; a composed harness needs its rulebook checked for
  self-consistency, not just each rule for correctness.)
- **Distribution and upgrade** — upgrades can be semantic: a harness can
  know what a version bump means and drive the migration, rather than
  handing a human a changelog.
- **Knowledge retention** — two systems built by the same harness look
  alike, so familiarity transfers; documentation is produced as part of the
  build because the harness insists on it.

## Where this ends up

Enterprise platforms are a core plus an enormous configuration layer; that
layer is exactly what moves into harnesses. The end state is bespoke software
for everyone — not bespoke from ground zero, but assembled by opinionated
harnesses that carry accumulated domain knowledge. The industry rearranges
around who owns the factory rather than who owns the code. Open-source
harnesses cover the common cases; this repo intends to be one of them.
