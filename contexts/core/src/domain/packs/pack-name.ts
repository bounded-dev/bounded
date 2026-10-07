import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./pack-name.contract.ts";

const schema = z
  .string({ error: "A pack name must be a string" })
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, {
    error: (issue) => `Pack name '${String(issue.input)}' must be lowercase words joined by single hyphens, such as 'path-gate'`,
  });

class PackNameImpl implements Contract.PackName {
  declare readonly __brand: "PackName";
  private constructor(readonly value: string) {}

  static parse(raw: unknown): Result<PackName> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new PackNameImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid pack name" };
  }

  equals(other: PackName): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type PackName = Contract.PackName;
export const PackName: Contract.PackNameFactory = PackNameImpl;
