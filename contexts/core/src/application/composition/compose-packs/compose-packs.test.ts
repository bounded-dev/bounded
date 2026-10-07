import { describe, expect, test } from "bun:test";
import { type AnyPack, definePack, point } from "@bounded/core/domain";
import { ComposePacksCommand } from "./compose-packs.command.ts";
import type { ComposePacksCatalog } from "./compose-packs.contract.ts";
import { ComposePacksHandler } from "./compose-packs.handler.ts";

class FakeCatalog implements ComposePacksCatalog {
  constructor(private readonly packs: readonly AnyPack[]) {}

  async available(): Promise<readonly AnyPack[]> {
    return this.packs;
  }
}

const base = definePack({
  id: "base",
  points: { items: point({ description: "Items", check: (raw) => (typeof raw === "string" ? { ok: true, value: raw } : { ok: false, error: "not text" }), values: ["x"] }) },
});
const { items } = base.points;

function command(...selected: string[]): ComposePacksCommand {
  const parsed = ComposePacksCommand.parse({ selected });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("ComposePacksHandler", () => {
  test("composes the selected packs from the catalog", async () => {
    const result = await new ComposePacksHandler(new FakeCatalog([base])).execute(command("base"));
    expect(result.ok && result.value.read(items)).toEqual({ ok: true, value: ["x"] });
  });

  test("passes a composition refusal through unchanged", async () => {
    expect(await new ComposePacksHandler(new FakeCatalog([base])).execute(command("nope"))).toEqual({
      ok: false,
      error: "Pack 'nope' is selected but not available. Make it available, or remove it from the selection",
    });
  });

  test("refuses when the catalog cannot be read", async () => {
    const broken: ComposePacksCatalog = {
      available: async () => {
        throw new Error("disk gone");
      },
    };
    expect(await new ComposePacksHandler(broken).execute(command("base"))).toEqual({
      ok: false,
      error: "The available packs cannot be listed (disk gone). Fix the pack catalog; nothing is composed until then",
    });
  });
});
