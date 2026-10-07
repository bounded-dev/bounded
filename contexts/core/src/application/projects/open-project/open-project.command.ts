import type { Result } from "bounded/domain";
import type * as Contract from "./open-project.contract.ts";

const INVALID = "A project root is an absolute directory path, such as /home/me/project";
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;

class OpenProjectCommandImpl implements Contract.OpenProjectCommand {
  declare readonly __brand: "OpenProjectCommand";
  private constructor(readonly root: string) {}

  static parse(raw: unknown): Result<OpenProjectCommand> {
    const root = typeof raw === "object" && raw !== null && Object.hasOwn(raw, "root") ? (raw as { root: unknown }).root : undefined;
    if (typeof root !== "string" || !ABSOLUTE.test(root)) return { ok: false, error: INVALID };
    return { ok: true, value: new OpenProjectCommandImpl(root) };
  }
}

export type OpenProjectCommand = Contract.OpenProjectCommand;
export const OpenProjectCommand: Contract.OpenProjectCommandFactory = OpenProjectCommandImpl;
