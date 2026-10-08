// bounded sync-config — rewrite a project's config from its composed packs
// (ADR LEG-2026-054).
//
//   bash .bounded/harness/scripts/bounded sync-config [--cwd <project>]
//
// The team lead's step, not a role's (ADR LEG-2026-072): the lead runs it as
// `bounded lead sync-config <issue>`, in that ticket's own worktree, only after
// the user agrees, because it overwrites whatever is on disk. No seat's
// toolset reaches this script directly (a bound role's shell runs only
// `bounded gates <gate>`, and the lead's shell only its own commands). When it
// changed anything (or a dependency tree is missing) it then runs the composed
// packs' own setup commands, which install only from the committed lockfile
// without lifecycle scripts: the lead's setup deliberately will not repeat
// after the first run (ADR LEG-2026-051), so this is the one supported reinstall.
// This pack names it as the composition's config sync through its
// `projectConfigSyncCommand` contribution.
import { resolve } from "node:path";
import { syncConfigCommand } from "./project-config.ts";

const result = syncConfigCommand(resolve(process.argv[2] ?? process.cwd()));
for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
process.exitCode = result.code;
