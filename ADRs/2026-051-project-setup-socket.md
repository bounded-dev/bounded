# 2026-051: Project dependency setup is a pack socket

**Status:** accepted

## Decision

The project entry (ADR 2026-048) installs dependencies through data sockets in a pack's `contrib.json`. The core names no package manager for the project:

- `projectSetupCommands` lists commands, each as a list of arguments. The entry runs them in composition order, in the project root, without a shell. Each command must install only from a committed lockfile and must not run the project package's own lifecycle scripts, so a manifest edit can never run code at install time. (No role may write the manifest since ADR 2026-054; this stays as defence in depth.) The TypeScript pack contributes `npm ci --ignore-scripts`. No supported stack needs install scripts: the pinned dependencies with native parts (esbuild, rolldown, lightningcss, the Tailwind engine) ship their binaries as optional platform packages, which install and load without scripts.
- `projectSetupProbes` lists project-relative paths that exist only after those commands succeed.
- `projectIgnoreRules` lists `.gitignore` lines for files that setup and builds produce. The core appends its own `.bounded` rules after them, so each rule must be anchored at the project root (`/dist/`), with a literal first segment other than `.git` or `.bounded`. Negation, escapes, character classes and `..` are refused. A pack rule therefore cannot reach or re-include harness state.
- `projectManifestScripts` lists pack scripts that the project initializer runs after it writes its own files. Each runs as `node <script> <project> <harness source root>`. They write the project's own build manifests. The TypeScript pack's script writes the package manifest and lockfile from the composed packs' `projectPackageTemplate`, `projectScripts` and `pins`, and refuses to overwrite an existing one. The core no longer writes the project's package file or lockfile.

The harness is itself a Node program with its own lockfile under `.bounded/harness`. Generating that manifest and lockfile at initialization (`agent/src/runtime-lock.ts`) and installing that runtime (`npm ci` there, checked by its `node_modules/.package-lock.json`) is core business and runs after the project's commands. A pack whose stack uses the same package manager may reuse `runtime-lock.ts` to derive its lockfile from the harness's source lock. Its package manifest and lockfile are generated at installation, declare no lifecycle scripts, and sit under `.bounded/`, which no role may write, so its install runs only harness-owned, pinned code. This is the dividing line: the core may name the tools that run the harness itself, but never the tools that build the project.

One module, `src/setup-state.ts`, gives both host entries and the lead policy the same answers. It uses only Node builtins, because it must run before any package is installed.

- **Ready:** the setup marker exists and every probe, including the harness runtime probe, is present.
- **Setup permitted:** the project is installed, and either no run has started or a completed setup needs repair because at least one contributed probe is missing. With every probe present after a run, setup is refused with that reason; an on-demand re-install would otherwise run whatever the package manifest last said. After ADR 2026-054 only the user's `bounded sync-config` rewrites it, and that command also reruns the composed setup commands. The entry treats a missing ticket, missing checksum state, and no `run-start` event as no run. If any guard-log line is unreadable or malformed, it assumes a run has started.
- **Before setup, or if the full adapter fails:** the lead may only read, list, search, and find inside the project. After links are resolved, every path and pattern must stay outside `.git` (in any letter case), and a listing or search may not be rooted at the project root, exactly as the full policy judges the lead's reads. The only other action is setup: `lead_setup` on pi, or exactly `bash .bounded/harness/scripts/bounded setup` from the project root on Claude Code. The entry denies everything else, including subagents, web access, and skills, and logs a detailed guard event.

The pi loader is generated but contains no logic. It imports the typed `hosts/pi/bootstrap.ts`.

## Why

In 2026-048, each host copied the same checks in three places, and the copies disagreed. The copies also wrote npm into the core. That breaks the core/pack split in `AGENTS.md`: a project from a non-npm pack would inherit the wrong setup.

## Consequences

A pack that brings a new language or package manager contributes its own setup commands, probes, and ignore rules as data. It needs no core change. A pack composition that contributes no setup installs only the harness runtime. The project package no longer gets a `bounded:setup` script. The pi setup tool cannot reload its own session, so after setup the lead is told to run `/reload`.
