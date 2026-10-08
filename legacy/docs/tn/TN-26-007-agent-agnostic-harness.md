---
number: TN-26-007
title: The agent-agnostic harness — one deterministic CLI, any agent framework
kind: design
status: draft
issue: 16
---

# The agent-agnostic harness

The Bounded Harness is not a configuration for one coding agent. It is a
**CLI-based, deterministic, opinionated harness** — the enforcement layer of
[VISION.md](../VISION.md) — that any capable agent framework can be strapped
into. The agent runtime is a component you rent; the harness is the part you
own, and it must therefore outlive any single runtime.

This note states the current picture. It is an iteration: the harness began
life as config for one runtime (pi), and the host-portability work
(ADR 2026-034, issue #16) turned the enforcement layer into something no
runtime owns.

## The shape

Two tiers, cleanly split:

- **Artifact gates are a CLI.** Everything that judges the *tree* — purity,
  design, drift, red, green, sign-off, deliver, mutation score, typecheck,
  the test run — is one command, `bounded gates <gate> [dir] [--json]`, over
  one result contract (exit `0` PASS, `1` BLOCK, `2` ERROR, and `3` RUNNING
  when a long gate's run outlasts a host's command limit and goes on in the
  background until the next call collects it, ADR 2026-073). No agent
  framework in the loop: CI, a shell, or any agent gets the same verdict from
  the same tree. This tier is 100% deterministic by construction.
- **Capability constraints are host adapters.** Everything that shapes what
  a *role can do* — stripping forbidden tools from the toolset, the path
  gate, the phase gate on spawns, sanitized worker views — needs the agent
  framework's cooperation. Each supported framework gets a thin adapter over
  the same pure decision cores, wired through whatever hook surface that
  framework exposes. The adapter enforces; it never re-decides.

A run's guard log records which host ran it and which constraints that host
enforced, so a gates-only transcript is never mistaken for a fully
constrained one.

## Supported frameworks

The harness targets the **key agent frameworks that expose enough hooks to
enforce with** — not all of them, and never one that can only be asked
nicely. Enforcement must be deterministic: tools removed rather than
refused, writes blocked rather than discouraged. A framework that offers no
hook surface for that cannot be a constrained host; it can still run the
gates, and the guard log will say that is all it did.

Today:

- **pi — the reference host.** Constraints ride pi's extension system
  (`agent/hosts/pi/extensions/`); role binding happens at launch via
  `bounded ticket`. pi is also the recommended and primary-tested host: its
  system prompt is minimal, so the harness's rules are nearly all the model
  reads — no negotiation with a large built-in prompt over tool habits,
  delegation, or tone.
- **Claude Code — the second host.** Constraints ride hooks
  (`agent/hosts/claude-code/`): a `PreToolUse` hook is the path gate and
  bash policy, generated agent definitions are the tool strip, and the hook
  injects host and role env itself so the gate process cannot be lied to.
  Claude Code carries a large system prompt of its own; it is supported and
  verified by fixture, but it is not the reference environment.

Each adapter is one directory — `hosts/pi/`, `hosts/claude-code/` — and
carries its own adapter for its framework's wiring. In developer mode,
`agent/scripts/bounded-init` runs the machine-level install scripts. Project-local
`bounded init` selects one host and copies only its adapter. Shared run state
lives in the project's `.bounded/` directory, owned by no host (ADR 2026-035).

Next: adapters for other hook-capable frameworks (Codex among the
candidates), each added the same way — a thin directory over the existing
cores, never a fork of the rules. Adding a host must never mean
re-implementing a gate.

## Distribution

The old install — a repo whose `agent/` directory is symlinked into the
frameworks' config homes (`~/.pi/agent`, `~/.claude/CLAUDE.md`) — remains
developer mode, where every edit is live immediately. `bounded init` instead
starts an empty project, selects a host explicitly, and installs the selected
harness into that project without a global symlink. The CLI
(`bounded gates`, `bounded ticket`, `bounded change-run`, behind the one
`bounded` command) is the framework-independent core every package carries.

## What this buys

- **One discipline everywhere.** A team member on Claude Code and one on pi
  are held to the same contracts, the same blindness, the same gates —
  because the gates are the same processes.
- **The harness survives runtime churn.** Frameworks version, change hook
  APIs, or fall out of favour; the enforcement layer and its evidence base
  do not move.
- **Honest comparability.** Dogfood runs across hosts measure the harness,
  not the host's prompt, because the guard log states what each host
  enforced.
