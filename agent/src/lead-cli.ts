// Narrow project-local run control for hosts that reach tools through a shell.
// The host hook validates the exact command before it reaches this process,
// with the same parser this CLI uses.
//
// `bounded lead release` is for the USER, from a terminal: it records that no
// architect is running, after a session died without its architect's end
// being recorded (lead-state.ts). The lead's own shell may never run it.
import { logGuardEvent, readGuardLog } from "./guard-log.ts";
import { ARCHITECT_ENDED, LEAD_GUARD, runningArchitects } from "./lead-state.ts";
import { LEAD_PREPARE_USAGE, parseLeadPrepareArgs, prepareLeadRun } from "./lead-run.ts";

const [action, ...args] = process.argv.slice(2);
if (action === "release" && args.length === 0) {
  const running = runningArchitects(readGuardLog(process.cwd()));
  if (running.length > 0) {
    logGuardEvent(process.cwd(), {
      guard: LEAD_GUARD,
      verdict: "pass",
      summary: `released ${running.length} architect launch(es) the log still counted as running`,
      detail: { kind: ARCHITECT_ENDED, all: true, released: true },
    });
  }
  process.stdout.write(running.length > 0 ? "released\n" : "no architect is recorded as running\n");
} else {
  const parsed = action === "prepare" ? parseLeadPrepareArgs(args) : undefined;
  if (parsed === undefined || !parsed.ok) {
    process.stderr.write(`usage: ${LEAD_PREPARE_USAGE}\n       bounded lead release\n`);
    process.exitCode = 2;
  } else {
    const result = prepareLeadRun(process.cwd(), parsed.ticket, parsed.fresh);
    const stream = result.ok ? process.stdout : process.stderr;
    stream.write(`${result.ok ? result.summary : result.reason}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}
