import type { callIdBrand } from "./call-id.contract.ts";
import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import { hasControl } from "../shared/text.ts";
import type * as Contract from "./call-id.contract.ts";

class CallIdImpl implements Contract.CallId {
  declare readonly __brand: "CallId";
  declare readonly [callIdBrand]: true;
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is CallIdImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<CallId> {
    if (CallIdImpl.made(raw)) return CallIdImpl.parse(wireFormOf(raw));
    if (typeof raw !== "string" || raw.trim() === "" || raw.length > 256 || hasControl(raw)) {
      return { ok: false, error: "A tool call id is non-empty text without control characters, at most 256 characters" };
    }
    return { ok: true, value: new CallIdImpl(raw) };
  }

  equals(other: CallId): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type CallId = Contract.CallId;
export const CallId: Contract.CallIdFactory = CallIdImpl;
