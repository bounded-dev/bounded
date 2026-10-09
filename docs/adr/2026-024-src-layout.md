# 2026-024: Everything the repository builds and ships lives under `src/`; `src/` is the `bounded` package

**Status:** accepted (the maintainer's decisions, and a reviewed plan). A
directory restructure with no behaviour change: no export name, bin, hook
path or behaviour changes, so no version bump; it ships with 3.3.0. Amends
ADRs [2026-002](2026-002-typed-extension-points.md),
[2026-003](2026-003-packs-refer-to-packs.md),
[2026-009](2026-009-path-gate-pack.md),
[2026-010](2026-010-project-configuration.md),
[2026-013](2026-013-restructure.md),
[2026-015](2026-015-host-installers.md),
[2026-016](2026-016-cli-app.md),
[2026-017](2026-017-adapters-by-port.md),
[2026-020](2026-020-shell-command-reading.md) and
[2026-021](2026-021-protected-paths-rename.md) where they state paths.

## Context

The repository kept its code in `contexts/` (the core, with the shipped
packs inside it, and the shell command reader) and `apps/` (the hosts and
the cli), with the repository's own tests at the root. The maintainer does
not want a `contexts/` folder: everything the repository builds and ships
goes under `src/`, and the root keeps only project files.

## Decision

### The tree

```
src/
  package.json  build-dist.ts  tsconfig.types.json  README.md  LICENSE   bounded, the published package; dist/ is built here
  core/        domain/ application/ adapters/ composition-root/ test/fixtures/
  packs/       protected-paths/  prereqs/
  lib/         shell-command-reader/  { package.json, domain/, adapters/, composition-root/, test/fixtures/ }
  hosts/       claude-code/ { package.json, *.ts, test/ }   pi/ { package.json, *.ts, test/ }
  cli/         { package.json, *.ts, test/ }
  test/        architecture.test.ts  architecture.rules.test-support.ts  compile-time.test.ts  packaging.test.ts  fixtures/compile-time/
```

The root keeps `.claude/`, `docs/`, `scripts/`, `package.json`, the
tsconfigs, `biome.json`, `bunfig.toml`, `bun.lock`, `test-preload.ts`,
`superseded-tests.json`, `AGENTS.md`, `CLAUDE.md`, `README.md` and
`LICENSE`.

### Was and is

| Was | Is |
| --- | --- |
| `contexts/core/src/{domain,application,adapters,composition-root}/` | `src/core/{…}/` |
| `contexts/core/src/packs/<name>/` | `src/packs/<name>/` |
| `contexts/core/test/fixtures/append-worker.ts` | `src/core/test/fixtures/append-worker.ts` |
| `contexts/core/test/fixtures/compile-time/` | `src/test/fixtures/compile-time/` |
| `contexts/core/{package.json,build-dist.ts,tsconfig.types.json,README.md,LICENSE}` | `src/` |
| `contexts/shell-command-reader/{package.json,test/}` | `src/lib/shell-command-reader/{…}` |
| `contexts/shell-command-reader/src/<layer>/` | `src/lib/shell-command-reader/<layer>/` |
| `apps/<host>/{package.json, src/*, test/}` | `src/hosts/<host>/{package.json, *, test/}` |
| `apps/cli/{package.json, src/*, test/}` | `src/cli/{package.json, *, test/}` |
| root `architecture.test.ts`, `architecture.rules.test-support.ts`, `compile-time.test.ts`, `packaging.test.ts` | `src/test/` |
| `dist/domain/index.js` (and the core's other library entries) | `dist/core/domain/index.js` |

Every file moved with `git mv`, so its history follows.

### The decisions

- **`src/` is the `bounded` package; the root stays a private workspace
  root.** `src/package.json` is the published manifest, beside
  `build-dist.ts`, `tsconfig.types.json`, the npm README and `LICENSE` (npm
  takes the licence from the package's own root), and the build output
  `src/dist/`. It is the rule taken literally (what ships is exactly
  `src/`'s package), and it keeps today's mechanics with the directory
  renamed: a private root holding the devDependencies and scripts, and one
  published workspace whose `prepack` builds `dist/`. Rejected: the root as
  the `bounded` package. The hosts, the cli and the library would need
  `"bounded": "workspace:*"` on the workspace root itself (undocumented in
  bun; with the hoisted linker, `node_modules/bounded -> ..`, a cycle), and
  it would publish the repository README and the root's devDependencies and
  scripts. Evidence: a spike on bun 1.3.14 with root `workspaces`
  `["src", "src/lib/*", "src/hosts/*", "src/cli"]` and the hoisted linker
  linked `bounded -> ../src`, the library, both hosts and the cli; a
  `--frozen-lockfile --ignore-scripts` install reported no changes; a host
  resolved `bounded/domain`; and `bun pm pack --dry-run` in `src` with
  brace-scoped exclusions packed only the package's own files. The build
  repeated the link check on the real tree.
- **Every workspace keeps its own `package.json`**; the root's `workspaces`
  is `["src", "src/lib/*", "src/hosts/*", "src/cli"]`. Package names are
  unchanged.
- **No inner `src/`.** A unit's source sits directly in its directory
  (`src/hosts/claude-code/hook.ts`, `src/lib/shell-command-reader/domain/…`),
  and each manifest's `exports` and `bin` drop `./src/`.
- **A unit's `test/` holds its end-to-end tests and fixtures, outside its
  layers.** The scans skip it; an app's source never imports it.
- **The concepts keep their names.** A **context** is `src/core` (in the
  package `bounded`) or `src/lib/<name>`; an **app** is `src/hosts/<name>`
  or `src/cli`. Every rule message and test title keeps its wording.
- **Shipped packs are bounded's, in `src/packs/<name>/`.** Every pack rule
  keeps its meaning: a pack imports `bounded/domain` only, its own directory
  and libraries `src/package.json` declares; only its `adapters/out/` does
  I/O; nothing outside it imports it but tests under a context's
  `composition-root/`; its ids come from `packIdsFor("bounded")`; R7
  applies. One rule narrows: before, any context could ship a pack
  (`contexts/*/src/packs/`); now only `bounded` does, and a `packs/` folder
  inside `src/core` or `src/lib/<name>` is no layer and is refused.
- **`dist/` mirrors `src/`** (the library build's root is `src`):
  `dist/core/domain/index.js`, `dist/packs/protected-paths/index.js`, with
  `dist/types` the same. `dist/cli.js`, `dist/hosts/…` and
  `dist/shell-command-reader/…` keep their paths. Users reach the library
  only through export names, which do not change.
- **No version bump**, for the reasons above; all five manifests stay at
  3.3.0.
- **`superseded-tests.json` is unchanged.** No case is superseded or
  retitled; its records name files by the paths they had at their own red
  commits, as history, and the red-first check consults a record only for a
  case its red commit owns.
- **`isBoundedHook` also recognises a checkout's
  `src/hosts/claude-code/main.ts`.** The documented hand install
  (`withHooks` with a command running the checkout's hook) now writes that
  path, so `bounded init` and `bounded update` must replace such a hook, not
  duplicate it, as they replaced one at `apps/claude-code/src/main.ts`. The
  older forms stay recognised: the bounded-claude-code package's `main.ts`
  and an older checkout's `apps/claude-code/src/main.ts`.
- **The CLI's version is bounded's in source too.** `bounded-cli.ts` reads
  `../package.json`: bundled (`dist/cli.js`) that is bounded's manifest, and
  from `src/cli/bounded-cli.ts` it is now `src/package.json` (it was
  `apps/cli/package.json`). Both carry the lockstep version.
- **The slice guides and ADR 2026-014 keep their paths**: they record what
  was built then. The ADRs that give paths as current guidance carry a
  one-sentence amendment in their status naming this ADR.

### The unit model

`src/test/architecture.rules.test-support.ts` holds one path-to-unit
function, `unitByPath`, the layout's grammar, and `unitOf`, which adds that
the unit has its `package.json`. A path's unit is its kind (`context`,
`pack` or `app`), its package's directory (`src` for the core and every
shipped pack), its source root (`src/core`, `src/packs/<name>`,
`src/lib/<name>`, `src/hosts/<name>`, `src/cli`) and its layer: a context's
layer, the pseudo-layer `packs` for any file of a shipped pack, `test` for
a unit's `test/`, none for an app's other files. A file outside every unit
(a loose file under `src/lib` or `src/hosts`, a `packs/` folder in a
context, a library or host without a `package.json`) is refused with the
reason. Every rule reads paths through it, so `bounded` is the core plus
its packs (one context for its value objects, its R2 declaring package and
its export paths) and a library is its own. Outside every scan:
`src/test/`, `src/dist/`, `src`'s own files and every unit's `test/`.

The architecture test also pins the layout: the root's tracked top-level
directories are exactly `.claude`, `docs`, `scripts` and `src`, and its
only TypeScript file is `test-preload.ts` (a new one is a layout decision:
record it in an ADR and add it there); `src/` holds exactly the package's
files and `cli`, `core`, `hosts`, `lib`, `packs` and `test`; the workspaces
are as above; and no code outside tests, nor any current guidance (AGENTS.md,
the README, `docs/*.md` but the slice guides), names `contexts/` or `apps/`,
but for named history.

### The red commit

The red commit carried only the test files whose text changes: the four
repository tests (moved to `src/test/`), the CLI's end-to-end test, the
red-first check's test, and the tests and fixtures whose computed or
relative paths change. The roughly 130 content-identical tests moved with
their sources in the build, as pure renames: `git diff -M100%
--name-status` between the red commit and the head shows each as `R100`,
and `bun run check` is green.
