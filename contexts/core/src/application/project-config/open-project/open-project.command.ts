import type { Result } from "bounded/domain";
import type * as Contract from "./open-project.contract.ts";

const INVALID = "A project root is an absolute directory path, such as /home/me/project";
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;

class OpenProjectCommandImpl implements Contract.OpenProjectCommand {
  declare readonly __brand: "OpenProjectCommand";
  private constructor(readonly projectRoot: string) {}

  static parse(raw: unknown): Result<OpenProjectCommand> {
    const projectRoot = typeof raw === "object" && raw !== null && Object.hasOwn(raw, "projectRoot") ? (raw as { projectRoot: unknown }).projectRoot : undefined;
    if (typeof projectRoot !== "string" || !ABSOLUTE.test(projectRoot)) return { ok: false, error: INVALID };
    return { ok: true, value: new OpenProjectCommandImpl(projectRoot) };
  }
}

export type OpenProjectCommand = Contract.OpenProjectCommand;
export const OpenProjectCommand: Contract.OpenProjectCommandFactory = OpenProjectCommandImpl;
