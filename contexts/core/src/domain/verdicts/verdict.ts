import { own, readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./verdict.contract.ts";

// Frozen plain objects; the brand exists only in types. Dispatch re-checks
// every verdict a guard returns with parse, so untyped code is held to the
// same form.
const INVALID = "A verdict is { kind: 'allow' } or { kind: 'refuse', reason, redirect } with a non-empty reason and redirect";
const allow = Object.freeze({ kind: "allow" }) as Contract.Allow;

/** The longest reason or redirect kept; longer text is shortened, saying so. */
const LIMIT = 2000;

/** One line of bounded text: control characters and line breaks (U+2028, U+2029 and U+0085 too) become single spaces. */
function line(value: string): string {
  let flat = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    const control = code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
    if (!control) flat += char;
    else if (!flat.endsWith(" ")) flat += " ";
  }
  flat = flat.trim();
  // Counted and cut in code points, so a character is never split in two.
  const characters = [...flat];
  return characters.length <= LIMIT ? flat : `${characters.slice(0, LIMIT).join("")}… (shortened from ${characters.length} characters)`;
}

function refuse(reason: string, redirect: string): Contract.Refuse {
  const text = (value: unknown, otherwise: string): string => {
    const flat = typeof value === "string" ? line(value) : "";
    return flat === "" ? otherwise : flat;
  };
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
export const Verdict: Contract.VerdictFactory = Object.freeze({ allow, refuse, parse });
