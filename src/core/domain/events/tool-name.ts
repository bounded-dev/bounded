import type { toolNameBrand } from "./tool-name.contract.ts";
import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import { hasControl } from "../shared/text.ts";
import type * as Contract from "./tool-name.contract.ts";

class ToolNameImpl implements Contract.ToolName {
  declare readonly __brand: "ToolName";
  declare readonly [toolNameBrand]: true;
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is ToolNameImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<ToolName> {
    if (ToolNameImpl.made(raw)) return ToolNameImpl.parse(wireFormOf(raw));
    if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "An invoke effect must name the tool it invokes" };
    if (hasControl(raw)) return { ok: false, error: "A tool name must not contain NUL or control characters" };
    return { ok: true, value: new ToolNameImpl(raw) };
  }

  equals(other: ToolName): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type ToolName = Contract.ToolName;
export const ToolName: Contract.ToolNameFactory = ToolNameImpl;
