import { Effect } from "../events/effect.ts";
import { readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { Verdict } from "../verdicts/verdict.ts";
import type * as Contract from "./after-tool-report.contract.ts";

const NOT_ONE = "it reported something that is not an after-tool report";

function parse(raw: unknown): Result<Contract.AfterToolReport> {
  return readSafely<Contract.AfterToolReport>("An after-tool report", () => {
    if (typeof raw !== "object" || raw === null || !("message" in raw) || !("record" in raw)) return { ok: false, error: NOT_ONE };
    const { message, record } = raw;
    if (!(message === null || typeof message === "string")) return { ok: false, error: NOT_ONE };
    if (record === null) return { ok: true, value: Object.freeze({ message, record: null }) };
    if (typeof record !== "object" || !("verdict" in record) || !("refusedBy" in record) || !("note" in record) || typeof record.note !== "string") return { ok: false, error: NOT_ONE };
    const verdict = Verdict.parse(record.verdict);
    if (!verdict.ok) return { ok: false, error: NOT_ONE };
    const { refusedBy, note } = record;
    if (refusedBy === null) return { ok: true, value: Object.freeze({ message, record: Object.freeze({ verdict: verdict.value, refusedBy: null, note }) }) };
    if (typeof refusedBy !== "object" || !("effect" in refusedBy)) return { ok: false, error: NOT_ONE };
    const effect = refusedBy.effect === null ? { ok: true as const, value: null } : Effect.parse(refusedBy.effect);
    if (!effect.ok) return { ok: false, error: NOT_ONE };
    return { ok: true, value: Object.freeze({ message, record: Object.freeze({ verdict: verdict.value, refusedBy: Object.freeze({ effect: effect.value }), note }) }) };
  });
}

export type AfterToolReport = Contract.AfterToolReport;
export const AfterToolReport: Contract.AfterToolReportFactory = Object.freeze({ parse });
