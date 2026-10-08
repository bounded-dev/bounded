import { describe, expect, test } from "bun:test";
import { type BasePack, definePack, packIdsFor } from "bounded/domain";
import type { ComposePacksCatalog } from "./compose-packs.contract.ts";

/** The behaviour every ComposePacksCatalog must have: it offers exactly the packs it was given, in order. */
export function composePacksCatalogConformance(name: string, fixture: (packs: readonly BasePack[]) => Promise<ComposePacksCatalog>): void {
  describe(`${name} conforms to ComposePacksCatalog`, () => {
    test("offers nothing when it holds nothing", async () => {
      const available = await (await fixture([])).available();
      expect(available.ok && available.value.packs).toEqual([]);
    });

    test("offers every pack it holds, the very objects, in order", async () => {
      const packId = packIdsFor("test-packs");
      const packs = [definePack({ id: packId("b") }), definePack({ id: packId("a") })];
      const available = await (await fixture(packs)).available();
      const listed = available.ok ? available.value.packs : [];
      expect(listed).toHaveLength(2);
      expect(listed[0]).toBe(packs[0] as BasePack);
      expect(listed[1]).toBe(packs[1] as BasePack);
    });

    test("refuses packs that cannot be composed from, saying why", async () => {
      const packId = packIdsFor("test-packs");
      const available = await (await fixture([definePack({ id: packId("a") }), definePack({ id: packId("a") })])).available();
      expect(available).toEqual({ ok: false, error: "Two available packs have the id 'test-packs/a'. An id names one pack in selections and messages: give each pack its own" });
    });
  });
}
