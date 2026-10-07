import { z } from "zod";
import { PackId, type Result } from "bounded/domain";
import type * as Contract from "./compose-packs.contract.ts";

// Wire contract: kept inside the module, since a zod schema cannot be frozen.
const composePacksSchema = z.object({
  selected: z.array(z.string()),
}) satisfies z.ZodType<Contract.ComposePacksInput>;

class ComposePacksCommandImpl implements Contract.ComposePacksCommand {
  declare readonly __brand: "ComposePacksCommand";
  private constructor(readonly selected: readonly PackId[]) {}

  static parse(raw: unknown): Result<ComposePacksCommand> {
    const input = composePacksSchema.safeParse(raw);
    if (!input.success) return { ok: false, error: "Invalid compose packs input: give { selected: [pack ids] }" };
    const selected: PackId[] = [];
    for (const name of input.data.selected) {
      const parsed = PackId.parse(name);
      if (!parsed.ok) return parsed;
      selected.push(parsed.value);
    }
    return { ok: true, value: new ComposePacksCommandImpl(Object.freeze(selected)) };
  }
}

export type ComposePacksCommand = Contract.ComposePacksCommand;
export const ComposePacksCommand: Contract.ComposePacksCommandFactory = ComposePacksCommandImpl;
