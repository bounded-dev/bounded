import { describe, expect, test } from "bun:test";
import { type AnyPack, definePack } from "@bounded/core/domain";
import type { ComposePacksCatalog } from "./compose-packs.contract.ts";

/** The behaviour every ComposePacksCatalog must have: it offers exactly the packs it was given, in order. */
export function composePacksCatalogConformance(name: string, fixture: (packs: readonly AnyPack[]) => Promise<ComposePacksCatalog>): void {
  describe(`${name} conforms to ComposePacksCatalog`, () => {
    test("offers nothing when it holds nothing", async () => {
      expect(await (await fixture([])).available()).toEqual([]);
    });

    test("offers every pack it holds, the very objects, in order", async () => {
      const packs = [definePack({ id: "b" }), definePack({ id: "a" })];
      const available = await (await fixture(packs)).available();
      expect(available).toHaveLength(2);
      expect(available[0]).toBe(packs[0] as AnyPack);
      expect(available[1]).toBe(packs[1] as AnyPack);
    });
  });
}
