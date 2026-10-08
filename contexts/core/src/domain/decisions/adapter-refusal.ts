import { own, readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import type { Refuse } from "../verdicts/verdict.contract.ts";
import { Verdict } from "../verdicts/verdict.ts";
import type * as Contract from "./adapter-refusal.contract.ts";

const NOT_ONE = "An adapter refusal is an object: { hostToolName, reason, redirect, role?, input? }";

class AdapterRefusalImpl implements Contract.AdapterRefusal {
  declare readonly __brand: "AdapterRefusal";
  readonly #made = true;

  private constructor(
    readonly role: string | null,
    readonly hostToolName: string,
    readonly input: unknown,
    readonly verdict: Refuse,
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is AdapterRefusalImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Contract.AdapterRefusal> {
    return readSafely<Contract.AdapterRefusal>("An adapter refusal", () => {
      const given = AdapterRefusalImpl.made(raw) ? wireFormOf(raw) : raw;
      if (typeof given !== "object" || given === null || Array.isArray(given)) return { ok: false, error: NOT_ONE };
      const role = own(given, "role");
      const verdict = Verdict.refuse(String(own(given, "reason") ?? ""), String(own(given, "redirect") ?? ""));
      return { ok: true, value: new AdapterRefusalImpl(typeof role === "string" ? role : null, String(own(given, "hostToolName") ?? "unknown"), own(given, "input"), verdict) };
    });
  }

  equals(other: Contract.AdapterRefusal): boolean {
    try {
      return sameWire(this, other);
    } catch {
      return false;
    }
  }

  toJSON(): Contract.AdapterRefusalJSON {
    return { hostToolName: this.hostToolName, reason: this.verdict.reason, redirect: this.verdict.redirect, role: this.role, input: this.input };
  }
}

export type AdapterRefusal = Contract.AdapterRefusal;
export const AdapterRefusal: Contract.AdapterRefusalFactory = AdapterRefusalImpl;
