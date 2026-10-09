import type { decisionTimeBrand } from "./decision-time.contract.ts";
import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import type * as Contract from "./decision-time.contract.ts";

const INVALID = "A decision time is ISO 8601 in UTC, as Date.prototype.toISOString writes it, such as 2026-01-02T03:04:05.000Z";

function isIso(raw: unknown): raw is string {
  try {
    return typeof raw === "string" && new Date(raw).toISOString() === raw;
  } catch {
    return false;
  }
}

class DecisionTimeImpl implements Contract.DecisionTime {
  declare readonly __brand: "DecisionTime";
  declare readonly [decisionTimeBrand]: true;
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is DecisionTimeImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<DecisionTime> {
    if (DecisionTimeImpl.made(raw)) return DecisionTimeImpl.parse(wireFormOf(raw));
    return isIso(raw) ? { ok: true, value: new DecisionTimeImpl(raw) } : { ok: false, error: INVALID };
  }

  equals(other: DecisionTime): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type DecisionTime = Contract.DecisionTime;
export const DecisionTime: Contract.DecisionTimeFactory = DecisionTimeImpl;
