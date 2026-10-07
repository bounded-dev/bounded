import { Composition, type AnyPack, type Result } from "bounded/domain";
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
    if (!Array.isArray(available)) {
      return { ok: false, error: "The pack catalog returned something other than a list of packs. Fix the pack catalog; nothing is composed until then" };
    }
    // The wire names packs by id; composition selects the pack objects. Ids
    // are resolved in id order, so the first refusal never depends on the
    // order they were given in.
    const selected: AnyPack[] = [];
    for (const id of [...command.selected].sort()) {
      const pack = available.find((candidate) => candidate.id === id);
      if (pack === undefined) return { ok: false, error: `Pack '${id}' is selected but not available. Make it available, or remove it from the selection` };
      selected.push(pack);
    }
    return Composition.compose(available, selected);
  }
}
