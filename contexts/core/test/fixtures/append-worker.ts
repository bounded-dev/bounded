// Appends many decisions to one log file, as one of two processes at once
// (see the file decision log's test). Arguments: file, worker number, count.
import { FileSystemDecisionLog } from "../../src/adapters/out/file-system/judging/decision-log.ts";
import { Decision, SessionStart, Verdict } from "../../src/domain/index.ts";

const [file = "", worker = "0", count = "0"] = process.argv.slice(2);
const start = SessionStart.parse({ role: null });
if (!start.ok) throw new Error(start.error);
const log = new FileSystemDecisionLog(file);
await Promise.all(
  Array.from({ length: Number(count) }, (_, i) =>
    log.record(Decision.of(`worker-${worker}-${i}`, new Date().toISOString(), start.value, { verdict: Verdict.refuse("x".repeat(500), "y"), refusedBy: null })),
  ),
);
