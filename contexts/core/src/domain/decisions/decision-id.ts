import type { decisionIdBrand } from "./decision-id.contract.ts";
import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import { hasControl } from "../shared/text.ts";
import type * as Contract from "./decision-id.contract.ts";

class DecisionIdImpl implements Contract.DecisionId {
  declare readonly __brand: "DecisionId";
  declare readonly [decisionIdBrand]: true;
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is DecisionIdImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<DecisionId> {
    if (DecisionIdImpl.made(raw)) return DecisionIdImpl.parse(wireFormOf(raw));
    if (typeof raw !== "string" || raw.trim() === "" || raw.length > 256 || hasControl(raw)) {
      return { ok: false, error: "A decision id is non-empty text without control characters, at most 256 characters" };
    }
    return { ok: true, value: new DecisionIdImpl(raw) };
  }

  equals(other: DecisionId): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type DecisionId = Contract.DecisionId;
export const DecisionId: Contract.DecisionIdFactory = DecisionIdImpl;
