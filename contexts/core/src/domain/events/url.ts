import { show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { hasControl } from "../shared/text.ts";
import type * as Contract from "./url.contract.ts";

class UrlImpl implements Contract.Url {
  declare readonly __brand: "Url";
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse trusts it as it is. */
  static made(raw: unknown): raw is UrlImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Url> {
    if (UrlImpl.made(raw)) return { ok: true, value: raw };
    if (typeof raw !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(raw) || hasControl(raw)) {
      return { ok: false, error: `Fetch URL '${show(raw)}' must be an absolute URL with a scheme, without spaces or control characters` };
    }
    return { ok: true, value: new UrlImpl(raw) };
  }

  equals(other: Url): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type Url = Contract.Url;
export const Url: Contract.UrlFactory = UrlImpl;
