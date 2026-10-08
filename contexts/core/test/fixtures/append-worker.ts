// Appends many decisions to one log file, as one of two processes at once
// (see the file guard log's test). Arguments: file, worker number, count.
import { FileSystemGuardLog } from "../../src/adapters/out/guard-log/guard-log.ts";
import { Decision, DecisionId, SessionStart, Verdict } from "../../src/domain/index.ts";

/** A decision id from known-good text. */
function decisionId(text: string): DecisionId {
  const parsed = DecisionId.parse(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const [file = "", worker = "0", count = "0"] = process.argv.slice(2);
const start = SessionStart.parse({ role: null });
if (!start.ok) throw new Error(start.error);
const log = new FileSystemGuardLog(file);
await Promise.all(
  Array.from({ length: Number(count) }, (_, i) =>
    log.record(Decision.of(decisionId(`worker-${worker}-${i}`), new Date().toISOString(), start.value, { verdict: Verdict.refuse("x".repeat(500), "y"), refusedBy: null })),
  ),
);
