import type { BasePack } from "../packs/pack.contract.ts";
import { parsePack } from "../packs/pack.ts";
import { PackId, packIdText } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./available-packs.contract.ts";

export const NOT_LISTS = "Compose takes a list of available packs and a list of selected packs";

class AvailablePacksImpl implements Contract.AvailablePacks {
  declare readonly __brand: "AvailablePacks";

  private constructor(readonly packs: readonly BasePack[]) {
    Object.freeze(this);
  }

  static parse(raw: unknown): Result<Contract.AvailablePacks> {
    if (raw instanceof AvailablePacksImpl) return { ok: true, value: raw };
    if (!Array.isArray(raw)) return { ok: false, error: NOT_LISTS };
    const packs: BasePack[] = [];
    for (const entry of raw) {
      const pack = parsePack(entry);
      if (!pack.ok) return { ok: false, error: `Available pack ${pack.error}` };
      packs.push(pack.value);
    }
    for (const pack of packs) {
      const id = PackId.parse(pack.id);
      if (!id.ok) return { ok: false, error: `Available pack '${packIdText(pack.id)}' has an invalid id: ${id.error}. Give it an id from packIdsFor(...)` };
    }
    // In id order, so which refusal comes first never depends on the order packs were listed in.
    const ids = packs.map((pack) => pack.id.value).sort();
    const duplicate = ids.find((id, i) => ids[i + 1] === id);
    if (duplicate !== undefined) return { ok: false, error: `Two available packs have the id '${duplicate}'. An id names one pack in selections and messages: give each pack its own` };
    return { ok: true, value: new AvailablePacksImpl(Object.freeze(packs)) };
  }

  includes(pack: BasePack): boolean {
    return this.packs.includes(pack);
  }
}

export type AvailablePacks = Contract.AvailablePacks;
export const AvailablePacks: Contract.AvailablePacksFactory = AvailablePacksImpl;
