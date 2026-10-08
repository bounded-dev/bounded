import { type AvailablePacks, type BasePack, Composition, type Result } from "bounded/domain";
import type { ComposePacks, ComposePacksCatalog, ComposePacksCommand } from "./compose-packs.contract.ts";

export class ComposePacksHandler implements ComposePacks {
  constructor(private readonly catalog: ComposePacksCatalog) {}

  async execute(command: ComposePacksCommand): Promise<Result<Composition>> {
    let catalogPacks: Result<AvailablePacks>;
    try {
      catalogPacks = await this.catalog.available();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `The available packs cannot be listed (${why}). Fix the pack catalog; nothing is composed until then` };
    }
    if (!catalogPacks.ok) return catalogPacks;
    const { packs: available } = catalogPacks.value;
    // The wire names packs by id; composition selects the pack objects, and
    // brings in from the catalog every pack they depend on. Ids are resolved
    // in id order, so the first refusal never depends on the order they were
    // given in.
    const listedPacks: BasePack[] = [];
    const ids = [...command.listedPackIds].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    for (const id of ids) {
      const pack = available.find((candidate) => id.equals(candidate.id));
      if (pack === undefined) return { ok: false, error: `Pack '${id.value}' is listed but not available. Make it available, or remove it from the list` };
      listedPacks.push(pack);
    }
    return Composition.compose(available, listedPacks);
  }
}
