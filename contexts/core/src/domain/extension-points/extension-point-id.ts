import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./extension-point-id.contract.ts";

const WORDS = "[a-z][a-z0-9]*(-[a-z0-9]+)*";
const schema = z
  .string({ error: "An extension point id must be a string" })
  .regex(new RegExp(`^${WORDS}(\\.${WORDS})*$`), {
    error: (issue) =>
      `Extension point id '${String(issue.input)}' must be lowercase words joined by hyphens, in dot-separated segments, such as 'path-gate.protected-paths'`,
  });

class ExtensionPointIdImpl implements Contract.ExtensionPointId {
  declare readonly __brand: "ExtensionPointId";
  private constructor(readonly value: string) {}

  static parse(raw: unknown): Result<ExtensionPointId> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new ExtensionPointIdImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid extension point id" };
  }

  equals(other: ExtensionPointId): boolean {
    return this.value === other.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export type ExtensionPointId = Contract.ExtensionPointId;
export const ExtensionPointId: Contract.ExtensionPointIdFactory = ExtensionPointIdImpl;
