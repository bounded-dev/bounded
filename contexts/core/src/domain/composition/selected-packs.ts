import type { selectedPacksBrand } from "./selected-packs.contract.ts";
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

/** The first of `packs` (in their order) that depends on `dependency`, or undefined. A malformed pack's dependencies are never read. */
export function firstDependent(packs: readonly BasePack[], dependency: BasePack): BasePack | undefined {
  return packs.find((pack) => pack.problem === undefined && pack.dependsOn.includes(dependency));
}

class SelectedPacksImpl implements Contract.SelectedPacks {
  declare readonly __brand: "SelectedPacks";
  declare readonly [selectedPacksBrand]: true;

  private constructor(
    readonly packs: readonly BasePack[],
    readonly listedPacks: readonly BasePack[],
  ) {
    Object.freeze(this);
  }

  static parse(raw: unknown): Result<Contract.SelectedPacks> {
    if (raw instanceof SelectedPacksImpl) return { ok: true, value: raw };
    if (!Array.isArray(raw)) return { ok: false, error: NOT_LISTS };
    const listed: BasePack[] = [];
    for (const entry of raw) {
      const pack = parsePack(entry);
      if (!pack.ok) return { ok: false, error: `Listed pack ${pack.error}` };
      listed.push(pack.value);
    }
    listed.sort(byId);
    const twice = listed.find((pack, i) => listed[i + 1] === pack);
    if (twice !== undefined) return { ok: false, error: `Pack '${packIdText(twice.id)}' is listed twice. List each pack once` };

    // The listed packs and, transitively, what they depend on. A malformed
    // pack's dependsOn is not followed: composition refuses the pack itself.
    const selected: BasePack[] = [];
    const bringIn = (pack: BasePack): void => {
      if (selected.includes(pack)) return;
      selected.push(pack);
      if (pack.problem !== undefined) return;
      for (const dependency of [...pack.dependsOn].sort(byId)) bringIn(dependency);
    };
    for (const pack of listed) bringIn(pack);
    selected.sort(byId);

    const twins = twinRefusal(selected, listed);
    if (twins !== undefined) return { ok: false, error: twins };
    return { ok: true, value: new SelectedPacksImpl(Object.freeze(selected), Object.freeze(listed)) };
  }
}

/**
 * Two or more different packs with one id in the selection, every one named
 * by where it comes from (listed first, then by the id of the first pack that
 * depends on it), for the smallest such id; or undefined. Picking one would
 * be a guess.
 */
function twinRefusal(selected: readonly BasePack[], listed: readonly BasePack[]): string | undefined {
  const twin = selected.find((pack, i) => {
    const next = selected[i + 1];
    return next !== undefined && byId(pack, next) === 0;
  });
  if (twin === undefined) return undefined;
  const id = packIdText(twin.id);
  // Each copy's origin: "listed", or the id of the first pack that depends on it.
  const origins = selected
    .filter((pack) => packIdText(pack.id) === id)
    .map((pack) => (listed.includes(pack) ? "" : packIdText(firstDependent(selected, pack)?.id)))
    .sort();
  // The first copy from an origin is "one", every later one from the same origin "another".
  const named = origins.map((origin, i) => {
    const article = origins.indexOf(origin) < i ? "another" : "one";
    return origin === "" ? `${article} listed` : `${article} that '${origin}' depends on`;
  });
  const copies = `${named.slice(0, -1).join(", ")}, and ${named.at(-1)}`;
  return `Two different packs have the id '${id}': ${copies}. They are two copies of one package, or two packs given one id; make every pack use the same one`;
}

export type SelectedPacks = Contract.SelectedPacks;
export const SelectedPacks: Contract.SelectedPacksFactory = SelectedPacksImpl;
