# 2026-021: The path gate is renamed the protected-paths pack

**Status:** accepted (the maintainer's decision of the name and of the
release, and a reviewed plan). Ships in `bounded` 3.3.0. Renames what ADR
2026-009 named; that ADR and the others keep their wording. Amended by
[ADR 2026-024](2026-024-src-layout.md) (src layout): the former-name scan
reads `src/**/*.ts`, `src/**/package.json`, `src/**/tsconfig*.json`,
`scripts/**/*.ts` and the root's `*.ts` and `tsconfig*.json`.

## Context

ADR 2026-009 shipped the first pack as the path gate, `bounded/path-gate`.
"Gate" is too generic a word for it: most packs gate something. What the
pack does is protect paths: deny-only rules on reads, listings and writes of
the paths a project names, and putting back protected files a shell command
changed (ADR 2026-013, drift). Its one extension point is already called
`protectedPaths`. The name of a thing must say exactly what it is
(AGENTS.md, "Working rules").

## Decision

- **The pack is the protected-paths pack.** In code:

  | Before | After |
  | --- | --- |
  | `bounded/path-gate`, `bounded/path-gate/adapters` (export paths and pack id) | `bounded/protected-paths`, `bounded/protected-paths/adapters` |
  | `contexts/core/src/packs/path-gate/` | `contexts/core/src/packs/protected-paths/` |
  | `path-gate.pack.ts`, `path-gate.contract.ts`, `path-gate.pack.test.ts` | `protected-paths.pack.ts`, `protected-paths.contract.ts`, `protected-paths.pack.test.ts` |
  | `domain/path-gate-id.*` | `domain/protected-paths-id.*` |
  | `pathGate` (the pack object) | `protectedPathsPack` |
  | `PathGate`, `PathGatePoints`, `PathGatePorts` | `ProtectedPathsPack`, `ProtectedPathsPackPoints`, `ProtectedPathsPackPorts` |
  | `PathGateId`, `pathGateId` | `ProtectedPathsId`, `protectedPathsId` |
  | `pathGatePortProvisions` | `protectedPathsPortProvisions` |

  In prose, messages and test titles "the path gate" is "the
  protected-paths pack": an unread shell command is refused with "the
  protected-paths pack cannot check shell commands", a rule's default reason
  is "the protected-paths pack protects '<match>'", and the core's example
  pack id is `bounded/protected-paths`.
- **The naming rule.** A pack object takes the `Pack` suffix where its bare
  name would clash with one of its own point keys, and otherwise keeps its
  bare name. `protectedPaths` is the pack's point key, which tests commonly
  bind (`const { protectedPaths } = ….points`), so the object is
  `protectedPathsPack`; `pathProtection` would be a second name for one
  thing. `prereqs` has no such clash and stays as it is. `corePack` is the
  precedent, and the other names follow its pattern (`CorePackPoints`,
  `CoreId`, `coreId`) and prereqs' (`prereqsPortProvisions`).
- **What does not change.** The point key `protectedPaths`, the port keys
  `watchedFiles` and `shellSnapshots`, the rule's shape (`ProtectedPath`,
  `ProtectedPathJSON`), `WatchedPath`, and every folder and file inside the
  pack but those above: they name concepts, not the pack. Ids built from the
  pack id change by themselves: the point is
  `bounded/protected-paths.protectedPaths`, the ports' owner is
  `bounded/protected-paths`, and a refusal starts
  `bounded/protected-paths refused …`.
- **Records.** Nothing bounded keeps reads a pack id back. The guard log is
  append-only, so its older records name `bounded/path-gate` and newer ones
  `bounded/protected-paths` ([the guard log](../guard-log.md)). Drift's
  snapshots are named by a hash of the call id and hold no pack id, nor do
  its quarantine or the prerequisites pack's records. Nothing is migrated.
- **No code names the old pack.** An architecture test reads the code, one
  line at a time: `.ts` files under `contexts/`, `apps/` and `scripts/` and
  at the root, the `package.json` of each context and app, and every
  `tsconfig*.json` (none under `node_modules/` or `dist/`). A line fails it
  when it holds the words "path" and "gate", in any case, joined by nothing
  or by one of `-`, `_`, `.`, `/` or a space, so a branch written before the
  rename fails loudly when it is merged. It does not catch the two words
  wrapped across lines, as prose in a comment may be. Docs, ADRs, `legacy/`
  and `superseded-tests.json` keep history and are not scanned.
- **Release.** 3.3.0 removes `bounded/path-gate` and
  `bounded/path-gate/adapters` with no compatibility kept (no alias, no
  tombstone, no upgrade hint), since 3.x has no users; a configuration
  written for 3.2.0 must be changed to import the new names.

## Consequences

- A configuration imports `protectedPathsPack` from
  `bounded/protected-paths`; a host passes `protectedPathsPortProvisions()`
  from `bounded/protected-paths/adapters` to `openProject`.
- ADR 2026-009 keeps its file name and wording, with a status line pointing
  here; `docs/slice-3.md` keeps its wording, with a note.
- Every test case the rename retitled is recorded in
  `superseded-tests.json`, so the red-first check of an earlier branch still
  finds its cases.
