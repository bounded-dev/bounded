import type { ComposePacksCatalog } from "@bounded/core/application";
import type { Pack } from "@bounded/core/domain";

/** The packs a host already holds in memory: the catalog for tests and for hosts that import their packs. */
export class InMemoryComposePacksCatalog implements ComposePacksCatalog {
  private readonly packs: readonly Pack[];

  constructor(packs: readonly Pack[]) {
    this.packs = Object.freeze([...packs]);
  }

  async available(): Promise<readonly Pack[]> {
    return this.packs;
  }
}
