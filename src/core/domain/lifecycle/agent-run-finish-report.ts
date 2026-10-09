import { own, readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { Verdict } from "../verdicts/verdict.ts";
import type * as Contract from "./agent-run-finish-report.contract.ts";

const NOT_ONE = "it reported something that is not an agent run finish report";

/** Whether `raw` is an object with exactly `keys`, each its own. */
const hasExactly = (raw: unknown, keys: readonly string[]): raw is object =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key));

function parse(raw: unknown): Result<Contract.AgentRunFinishReport> {
  return readSafely<Contract.AgentRunFinishReport>("An agent run finish report", () => {
    if (!hasExactly(raw, ["record"])) return { ok: false, error: NOT_ONE };
    const record = own(raw, "record");
    if (record === null) return { ok: true, value: Object.freeze({ record: null }) };
    if (!hasExactly(record, ["verdict", "note"])) return { ok: false, error: NOT_ONE };
    const note = own(record, "note");
    const verdict = Verdict.parse(own(record, "verdict"));
    if (typeof note !== "string" || !verdict.ok) return { ok: false, error: NOT_ONE };
    return { ok: true, value: Object.freeze({ record: Object.freeze({ verdict: verdict.value, note }) }) };
  });
}

export type AgentRunFinishReport = Contract.AgentRunFinishReport;
export const AgentRunFinishReport: Contract.AgentRunFinishReportFactory = Object.freeze({ parse });
