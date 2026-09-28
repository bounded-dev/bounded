// Narrow project-local run control for hosts that reach tools through a shell.
// The host hook validates the exact command before it reaches this process,
// with the same parser this CLI uses.
import { LEAD_PREPARE_USAGE, parseLeadPrepareArgs, prepareLeadRun } from "./lead-run.ts";

const [action, ...args] = process.argv.slice(2);
const parsed = action === "prepare" ? parseLeadPrepareArgs(args) : undefined;
if (parsed === undefined || !parsed.ok) {
  process.stderr.write(`usage: ${LEAD_PREPARE_USAGE}\n`);
  process.exitCode = 2;
} else {
  const result = prepareLeadRun(process.cwd(), parsed.ticket, parsed.fresh);
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${result.ok ? result.summary : result.reason}\n`);
  if (!result.ok) process.exitCode = 1;
}
