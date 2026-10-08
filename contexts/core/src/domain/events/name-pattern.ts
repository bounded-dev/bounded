import type { Result } from "../shared/result.ts";
import type * as Contract from "./name-pattern.contract.ts";

class NamePatternImpl implements Contract.NamePattern {
  declare readonly __brand: "NamePattern";
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse trusts it as it is. */
  static made(raw: unknown): raw is NamePatternImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<NamePattern> {
    if (NamePatternImpl.made(raw)) return { ok: true, value: raw };
    if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "A list's filter is a non-empty file-name pattern, or null" };
    return { ok: true, value: new NamePatternImpl(raw) };
  }

  equals(other: NamePattern): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type NamePattern = Contract.NamePattern;
export const NamePattern: Contract.NamePatternFactory = NamePatternImpl;
