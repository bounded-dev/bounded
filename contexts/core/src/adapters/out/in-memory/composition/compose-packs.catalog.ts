import type { ComposePacksCatalog } from "bounded/application";
import type { AnyPack } from "bounded/domain";

/** The packs a host already holds in memory: the catalog for tests and for hosts that import their packs. */
export class InMemoryComposePacksCatalog implements ComposePacksCatalog {
  private readonly packs: readonly AnyPack[];

  constructor(packs: readonly AnyPack[]) {
    this.packs = Object.freeze([...packs]);
  }

  async available(): Promise<readonly AnyPack[]> {
    return this.packs;
  }
}
