import { show } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import { hasControl } from "../shared/text.ts";
import type * as Contract from "./url.contract.ts";

class UrlImpl implements Contract.Url {
  declare readonly __brand: "Url";
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is UrlImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Url> {
    if (UrlImpl.made(raw)) return UrlImpl.parse(wireFormOf(raw));
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
