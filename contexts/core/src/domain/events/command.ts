import type { Result } from "../shared/result.ts";
import { wireFormOf } from "../shared/wire.ts";
import { hasControl } from "../shared/text.ts";
import type * as Contract from "./command.contract.ts";

class CommandImpl implements Contract.Command {
  declare readonly __brand: "Command";
  readonly #made = true;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is CommandImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown): Result<Command> {
    if (CommandImpl.made(raw)) return CommandImpl.parse(wireFormOf(raw));
    if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "An execute effect must name the command it runs" };
    if (raw.includes("\0")) return { ok: false, error: "A command must not contain a NUL character" };
    if (hasControl(raw, "\t\n\r")) return { ok: false, error: "A command must not contain control characters other than tab and line breaks" };
    return { ok: true, value: new CommandImpl(raw) };
  }

  equals(other: Command): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type Command = Contract.Command;
export const Command: Contract.CommandFactory = CommandImpl;
