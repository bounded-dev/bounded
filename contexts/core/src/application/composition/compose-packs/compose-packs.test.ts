import { describe, expect, test } from "bun:test";
import { AvailablePacks, type BasePack, contribution, definePack, packIdsFor, point, type Result } from "bounded/domain";
import { ComposePacksCommand } from "./compose-packs.command.ts";
import type { ComposePacksCatalog } from "./compose-packs.contract.ts";
import { ComposePacksHandler } from "./compose-packs.handler.ts";

class FakeCatalog implements ComposePacksCatalog {
  constructor(private readonly packs: readonly BasePack[]) {}

  async available(): Promise<Result<AvailablePacks>> {
    return AvailablePacks.parse(this.packs);
  }
}

const packId = packIdsFor("test-packs");
const text = (raw: unknown) => (typeof raw === "string" ? { ok: true as const, value: raw } : { ok: false as const, error: "not text" });
const base = definePack({ id: packId("base"), points: { items: point({ description: "Items", check: text, values: ["x"] }) } });

const ext = definePack({ id: packId("ext"), dependsOn: [base], contributes: [contribution(base.points.items, ["y"])] });

function command(...listed: string[]): ComposePacksCommand {
  const parsed = ComposePacksCommand.parse({ listedPackIds: listed });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("ComposePacksHandler", () => {
  test("composes the selected packs from the catalog", async () => {
    const result = await new ComposePacksHandler(new FakeCatalog([base])).execute(command("test-packs/base"));
    expect(result.ok && result.value.read(base.points.items)).toEqual({ ok: true, value: ["x"] });
  });

  test("passes a composition refusal through unchanged", async () => {
    const twin = definePack({ id: packId("base") });
    expect(await new ComposePacksHandler(new FakeCatalog([base, twin])).execute(command("test-packs/base"))).toEqual({
      ok: false,
      error: "Two available packs have the id 'test-packs/base'. An id names one pack in selections and messages: give each pack its own",
    });
  });

  test("refuses an id the catalog does not offer", async () => {
    expect(await new ComposePacksHandler(new FakeCatalog([base])).execute(command("test-packs/nope"))).toEqual({
      ok: false,
      error: "Pack 'test-packs/nope' is listed but not available. Make it available, or remove it from the list",
    });
  });

  test("refuses ids the catalog does not offer in id order, whatever the selection order", async () => {
    const refusal = {
      ok: false as const,
      error: "Pack 'test-packs/abc' is listed but not available. Make it available, or remove it from the list",
    };
    const handler = new ComposePacksHandler(new FakeCatalog([base]));
    expect(await handler.execute(command("test-packs/zed", "test-packs/abc"))).toEqual(refusal);
    expect(await handler.execute(command("test-packs/abc", "test-packs/zed"))).toEqual(refusal);
  });

  test("a listed pack's dependencies come from the catalog", async () => {
    const result = await new ComposePacksHandler(new FakeCatalog([base, ext])).execute(command("test-packs/ext"));
    expect(result.ok && result.value.read(base.points.items)).toEqual({ ok: true, value: ["x", "y"] });
  });

  test("a dependency the catalog does not offer is refused", async () => {
    expect(await new ComposePacksHandler(new FakeCatalog([ext])).execute(command("test-packs/ext"))).toEqual({
      ok: false,
      error: "Pack 'test-packs/ext' depends on pack 'test-packs/base', which is not available. Add 'test-packs/base' to the available packs, or remove the dependency",
    });
  });

  test("refuses when the catalog cannot be read", async () => {
    const broken: ComposePacksCatalog = {
      available: async () => {
        throw new Error("disk gone");
      },
    };
    expect(await new ComposePacksHandler(broken).execute(command("test-packs/base"))).toEqual({
      ok: false,
      error: "The available packs cannot be listed (disk gone). Fix the pack catalog; nothing is composed until then",
    });
  });
});
