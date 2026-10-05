# 2026-034: Enforcement is host-portable — artifact gates as a CLI, capability constraints per host

**Status:** accepted; amended by 2026-069, 2026-073

## Decision

Every mechanism the harness enforces is one of two tiers, declared, not
implied:

- **Artifact gates** inspect the tree: purity, design, drift, red, green,
  sign-off, deliver, mutation score, typecheck, the test run, the recorded
  review, surface check, scaffold. They are host-independent by
  construction and are exposed **once**, as a CLI — `bounded gates <gate> [cwd]
  [--json]` — over a single result contract (`src/gate-result.ts`: code
  `0|1|2|3`, verdict, summary, lines, detail; exit `0` PASS, `1` BLOCK, `2`
  ERROR, `3` RUNNING, `64` usage). RUNNING is produced only by the core's
  `gateRunning`, for a long gate whose background run outlasts the host's
  call (ADR 2026-073); a runner's own 3 is still ERROR. A pack contributes its gates through `packs/<lang>/
  gates.ts`; the root discovers them by convention and names no technology.
- **Capability constraints** shape what a role *can do*: the tool strip,
  the path gate, the phase gate on spawns, the sanitized worker views. They
  need host cooperation and are exposed **per host**, as a thin adapter over
  the pure cores (`decide()`, `checkSubagentCall()`, `sessionRole()`):
  the pi adapter (`hosts/pi/extensions/`) today, `hosts/claude-code/`
  hooks as the second host (adapter layout: ADR 2026-035).

A host declares which constraints it enforces, and the guard log records it
once per run. A run whose host enforces nothing — `bounded gates` from a bare
shell — records that its capability constraints were unenforced. Gates alone
are never reported as blindness.

The pi tools and the CLI read the **same registry**. A gate's name,
description, flags and prompt guidance live in the registry entry; the
extension iterates it rather than hand-wiring each tool.

## Why

The logic under every gate was already plain TypeScript (`dev-tools.ts`
describes itself as "the thin pi-facing wiring"), but the seam was never a
contract: the trailing verdict line, `targetCwd`, and the `run_tests` and
`typecheck` guard events lived only in the extension, and `GateResult` was
declared four separate times. Meanwhile the strongest mechanisms —
`pi.setActiveTools`, the `tool_call` hook, `subagentOnlyExtensions` — are
pi API calls with no analogue anywhere else. Comparing against a
shell-and-markdown kit made the asymmetry plain: the harness's
differentiator was also its lock-in, and its portable half was not exposed.

Declaring the tiers costs little and buys three things at once: the gates
become usable from any agent, from CI and by a person; a second host needs
only the Tier B adapter; and self-hosting (#15) has a command line to drive.
Claude Code's subagent `hooks:` and `tools:` frontmatter are the exact
counterparts of `subagentOnlyExtensions` and the tool strip, so the second
adapter binds a role the same way pi does — by which definition loads it.

## Consequences

- `bounded gates` is installed by `bounded init` beside `bounded ticket`.
- In Claude Code `bash` is not forbidden; it is the carrier for `bounded gates`,
  and the hook narrows it to exactly the gates in the role's `ROLE_TOOLS`.
  Anything else — compound commands, redirects, substitutions — is refused
  with the role's `forbiddenWhy` reason. One list, derived, never a second.
- The CLI does not enforce who may run a gate. That is Tier B's job, and a
  host without it says so in the log.
- Drift tests extend to the registry and the rendered Claude Code agent
  definitions: `tools:` allowlists are pinned to `ROLE_TOOLS`.
- The first live Claude Code run is a dogfood entry, not a claim this ADR
  makes; the adapter is verified by fixture until then.
