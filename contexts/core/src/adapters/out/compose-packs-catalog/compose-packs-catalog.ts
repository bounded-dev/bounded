import type { ComposePacksCatalog } from "bounded/application";
import { AvailablePacks, type BasePack, type Result } from "bounded/domain";

/** The packs a host already holds in memory: the catalog for tests and for hosts that import their packs. */
export class InMemoryComposePacksCatalog implements ComposePacksCatalog {
  private readonly packs: readonly BasePack[];

  constructor(packs: readonly BasePack[]) {
    this.packs = Object.freeze([...packs]);
  }

  async available(): Promise<Result<AvailablePacks>> {
    return AvailablePacks.parse(this.packs);
  }
}
