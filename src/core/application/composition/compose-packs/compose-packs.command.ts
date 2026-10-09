import type { composePacksCommandBrand } from "./compose-packs.contract.ts";
import { z } from "zod";
import { PackId, type Result } from "bounded/domain";
import type * as Contract from "./compose-packs.contract.ts";

// Wire contract: kept inside the module, since a zod schema cannot be frozen.
const composePacksSchema = z.object({
  listedPackIds: z.array(z.string()),
}) satisfies z.ZodType<Contract.ComposePacksInput>;

class ComposePacksCommandImpl implements Contract.ComposePacksCommand {
  declare readonly __brand: "ComposePacksCommand";
  declare readonly [composePacksCommandBrand]: true;
  private constructor(readonly listedPackIds: readonly PackId[]) {}

  static parse(raw: unknown): Result<ComposePacksCommand> {
    const input = composePacksSchema.safeParse(raw);
    if (!input.success) return { ok: false, error: "Invalid compose packs input: give { listedPackIds: [pack ids] }" };
    const listedPackIds: PackId[] = [];
    for (const name of input.data.listedPackIds) {
      const parsed = PackId.parse(name);
      if (!parsed.ok) return parsed;
      listedPackIds.push(parsed.value);
    }
    return { ok: true, value: new ComposePacksCommandImpl(Object.freeze(listedPackIds)) };
  }
}

export type ComposePacksCommand = Contract.ComposePacksCommand;
export const ComposePacksCommand: Contract.ComposePacksCommandFactory = ComposePacksCommandImpl;
