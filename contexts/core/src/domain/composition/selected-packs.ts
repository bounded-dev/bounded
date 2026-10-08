import type { BasePack } from "../packs/pack.contract.ts";
import { parsePack } from "../packs/pack.ts";
import { packIdText } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import { NOT_LISTS } from "./available-packs.ts";
import type * as Contract from "./selected-packs.contract.ts";

/** Packs in id order. */
export const byId = (a: BasePack, b: BasePack): number => {
  const [x, y] = [packIdText(a.id), packIdText(b.id)];
  return x < y ? -1 : x > y ? 1 : 0;
};

class SelectedPacksImpl implements Contract.SelectedPacks {
  declare readonly __brand: "SelectedPacks";

  private constructor(readonly packs: readonly BasePack[]) {
    Object.freeze(this);
  }

  static parse(raw: unknown): Result<Contract.SelectedPacks> {
    if (raw instanceof SelectedPacksImpl) return { ok: true, value: raw };
    if (!Array.isArray(raw)) return { ok: false, error: NOT_LISTS };
    const packs: BasePack[] = [];
    for (const entry of raw) {
      const pack = parsePack(entry);
      if (!pack.ok) return { ok: false, error: `Selected pack ${pack.error}` };
      packs.push(pack.value);
    }
    packs.sort(byId);
    const twice = packs.find((pack, i) => packs[i + 1] === pack);
    if (twice !== undefined) return { ok: false, error: `Pack '${packIdText(twice.id)}' is selected twice. Select each pack once` };
    return { ok: true, value: new SelectedPacksImpl(Object.freeze(packs)) };
  }
}

export type SelectedPacks = Contract.SelectedPacks;
export const SelectedPacks: Contract.SelectedPacksFactory = SelectedPacksImpl;
