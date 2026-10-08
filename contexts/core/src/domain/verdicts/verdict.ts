import { own, readSafely } from "../shared/read.ts";
import type { Result } from "../shared/result.ts";
import { sameWire, wireFormOf } from "../shared/wire.ts";
import type * as Contract from "./verdict.contract.ts";

// Dispatch re-checks every verdict a guard returns with parse, so untyped
// code is held to the same form.
const INVALID = "A verdict is { kind: 'allow' } or { kind: 'refuse', reason, redirect } with a non-empty reason and redirect";

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

/** One line of text, or `otherwise` when there is none. */
function text(value: unknown, otherwise: string): string {
  const flat = typeof value === "string" ? line(value) : "";
  return flat === "" ? otherwise : flat;
}

const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

class AllowImpl implements Contract.Allow {
  declare readonly __brand: "Verdict";
  readonly #made = true;
  readonly kind = "allow" as const;
  /** The one allow. */
  static readonly allow: Contract.Allow = new AllowImpl();

  private constructor() {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is AllowImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  equals(other: Verdict): boolean {
    return other.kind === "allow";
  }

  toJSON(): Contract.AllowJSON {
    return { kind: this.kind };
  }
}

class RefuseImpl implements Contract.Refuse {
  declare readonly __brand: "Verdict";
  readonly #made = true;
  readonly kind = "refuse" as const;

  private constructor(
    readonly reason: string,
    readonly redirect: string,
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is RefuseImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static refuse(reason: string, redirect: string): Contract.Refuse {
    return new RefuseImpl(text(reason, "The action was refused without a reason"), text(redirect, "Ask the maintainer of the refusing guard for the permitted next step"));
  }

  equals(other: Verdict): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.RefuseJSON {
    return { kind: this.kind, reason: this.reason, redirect: this.redirect };
  }
}

// Own fields only; extra fields are dropped. An unknown kind is refused, so
// a later third form fails closed until it exists.
function parse(raw: unknown): Result<Verdict> {
  return readSafely<Verdict>("A verdict", () => {
    if (AllowImpl.made(raw) || RefuseImpl.made(raw)) return parse(wireFormOf(raw));
    if (typeof raw !== "object" || raw === null) return { ok: false, error: INVALID };
    const kind = own(raw, "kind");
    if (kind === "allow") return { ok: true, value: AllowImpl.allow };
    const [reason, redirect] = [own(raw, "reason"), own(raw, "redirect")];
    if (kind === "refuse" && filled(reason) && filled(redirect)) return { ok: true, value: RefuseImpl.refuse(reason, redirect) };
    return { ok: false, error: INVALID };
  });
}

export type Verdict = Contract.Verdict;
export const Verdict: Contract.VerdictFactory = Object.freeze({ allow: AllowImpl.allow, refuse: RefuseImpl.refuse, parse });
