// bounded sync-config — rewrite a project's config from its composed packs
// (ADR 2026-054).
//
//   bash .bounded/harness/scripts/bounded sync-config [--cwd <project>]
//
// The user's command, not a role's: no seat's toolset reaches it (a bound
// role's shell runs only `bounded gates <gate>`, and the team lead's only
// command is setup). It overwrites whatever is on disk, which may be the
// user's own deliberate edit, so it is a decision for the person who owns the
// project. When it changed anything (or a dependency tree is missing) it then
// runs the composed packs' own setup commands, which install only from the
// committed lockfile without lifecycle scripts: the lead's setup deliberately
// will not repeat after the first run (ADR 2026-051), so this is the one
// supported reinstall.
import { resolve } from "node:path";
import { syncConfigCommand } from "./project-config.ts";

const result = syncConfigCommand(resolve(process.argv[2] ?? process.cwd()));
for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
process.exitCode = result.code;
