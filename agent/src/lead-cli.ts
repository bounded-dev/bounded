// The team lead's commands from a shell (ADR 2026-066): `bounded lead ...`.
// A host that reaches tools through a shell validates the exact command with
// the same parser before it reaches this process (hosts/claude-code/
// lead-hook.ts); pi calls the same commands in-process. Exit 0 done, 1
// refused, 3 still running in the background (a merge's check, ADR
// 2026-073: run the same command again), 64 usage.
import { leadDeps, parseLeadArgs, runLeadCommand } from "./lead-commands.ts";
import { openTracker } from "../trackers/index.ts";

const parsed = parseLeadArgs(process.argv.slice(2));
if (!parsed.ok) {
  process.stderr.write(`${parsed.reason}\n`);
  process.exitCode = 64;
} else {
  const outcome = await runLeadCommand(process.cwd(), parsed.request, leadDeps(openTracker, process.env["BOUNDED_HOST"]));
  (outcome.ok || outcome.running === true ? process.stdout : process.stderr).write(`${outcome.text}\n`);
  if (!outcome.ok) process.exitCode = outcome.running === true ? 3 : 1;
}
