import { Composition, type AnyPack, type Result } from "@bounded/core/domain";
import type { ComposePacks, ComposePacksCatalog, ComposePacksCommand } from "./compose-packs.contract.ts";

export class ComposePacksHandler implements ComposePacks {
  constructor(private readonly catalog: ComposePacksCatalog) {}

  async execute(command: ComposePacksCommand): Promise<Result<Composition>> {
    let available: readonly AnyPack[];
    try {
      available = await this.catalog.available();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `The available packs cannot be listed (${why}). Fix the pack catalog; nothing is composed until then` };
    }
    return Composition.compose(available, command.selected.map((name) => name.value));
  }
}
