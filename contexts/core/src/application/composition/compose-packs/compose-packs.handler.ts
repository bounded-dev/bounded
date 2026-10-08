import { type AvailablePacks, type BasePack, Composition, type Result } from "bounded/domain";
import type { ComposePacks, ComposePacksCatalog, ComposePacksCommand } from "./compose-packs.contract.ts";

export class ComposePacksHandler implements ComposePacks {
  constructor(private readonly catalog: ComposePacksCatalog) {}

  async execute(command: ComposePacksCommand): Promise<Result<Composition>> {
    let listed: Result<AvailablePacks>;
    try {
      listed = await this.catalog.available();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `The available packs cannot be listed (${why}). Fix the pack catalog; nothing is composed until then` };
    }
    if (!listed.ok) return listed;
    const { packs: available } = listed.value;
    // The wire names packs by id; composition selects the pack objects. Ids
    // are resolved in id order, so the first refusal never depends on the
    // order they were given in.
    const selectedPacks: BasePack[] = [];
    const ids = [...command.selectedPackIds].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    for (const id of ids) {
      const pack = available.find((candidate) => id.equals(candidate.id));
      if (pack === undefined) return { ok: false, error: `Pack '${id.value}' is selected but not available. Make it available, or remove it from the selection` };
      selectedPacks.push(pack);
    }
    return Composition.compose(available, selectedPacks);
  }
}
