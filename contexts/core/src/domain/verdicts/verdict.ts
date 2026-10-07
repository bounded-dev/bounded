import { own, readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./verdict.contract.ts";

// Frozen plain objects; the brand exists only in types. Dispatch re-checks
// every verdict a guard returns with parse, so untyped code is held to the
// same form.
const INVALID = "A verdict is { kind: 'allow' } or { kind: 'refuse', reason, redirect } with a non-empty reason and redirect";
const allow = Object.freeze({ kind: "allow" }) as Contract.Allow;

function refuse(reason: string, redirect: string): Contract.Refuse {
  const text = (value: unknown, otherwise: string): string => (typeof value === "string" && value.trim() !== "" ? value.trim() : otherwise);
  return Object.freeze({
    kind: "refuse",
    reason: text(reason, "The action was refused without a reason"),
    redirect: text(redirect, "Ask the maintainer of the refusing guard for the permitted next step"),
  }) as Contract.Refuse;
}

const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

// Own fields only; extra fields are dropped. An unknown kind is refused, so
// a later third form fails closed until it exists.
function parse(raw: unknown): Result<Verdict> {
  return readSafely<Verdict>("A verdict", () => {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: INVALID };
    const kind = own(raw, "kind");
    if (kind === "allow") return { ok: true, value: allow };
    const [reason, redirect] = [own(raw, "reason"), own(raw, "redirect")];
    if (kind === "refuse" && filled(reason) && filled(redirect)) return { ok: true, value: refuse(reason, redirect) };
    return { ok: false, error: INVALID };
  });
}

export type Verdict = Contract.Verdict;
export const Verdict: Contract.VerdictFactory = { allow, refuse, parse };
