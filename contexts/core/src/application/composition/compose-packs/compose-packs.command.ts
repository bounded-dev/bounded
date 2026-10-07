import { z } from "zod";
import { PackName, type Result } from "@bounded/core/domain";
import type * as Contract from "./compose-packs.contract.ts";

// Wire contract: what an in adapter validates before calling the feature.
export const composePacksSchema = z.object({
  selected: z.array(z.string()),
}) satisfies z.ZodType<Contract.ComposePacksInput>;

class ComposePacksCommandImpl implements Contract.ComposePacksCommand {
  declare readonly __brand: "ComposePacksCommand";
  private constructor(readonly selected: readonly PackName[]) {}

  static parse(raw: unknown): Result<ComposePacksCommand> {
    const input = composePacksSchema.safeParse(raw);
    if (!input.success) return { ok: false, error: "Invalid compose packs input: give { selected: [pack names] }" };
    const selected: PackName[] = [];
    for (const name of input.data.selected) {
      const parsed = PackName.parse(name);
      if (!parsed.ok) return parsed;
      selected.push(parsed.value);
    }
    return { ok: true, value: new ComposePacksCommandImpl(Object.freeze(selected)) };
  }
}

export type ComposePacksCommand = Contract.ComposePacksCommand;
export const ComposePacksCommand: Contract.ComposePacksCommandFactory = ComposePacksCommandImpl;
