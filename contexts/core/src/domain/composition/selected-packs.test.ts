import { describe, expect, test } from "bun:test";
import { definePack } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import { SelectedPacks } from "./selected-packs.ts";

const packId = packIdsFor("test-packs");
const a = definePack({ id: packId("a") });
const b = definePack({ id: packId("b") });
const notBuilt = (id: string) => `Selected pack '${id}' was not built with definePack(...), or was built by a different copy of bounded. Build every pack with definePack from one copy`;

describe("SelectedPacks — the packs a configuration selects", () => {
  test("a list of packs definePack made, each once, kept in id order whatever the listing order", () => {
    const parsed = SelectedPacks.parse([b, a]);
    expect(parsed.ok && parsed.value.packs).toEqual([a, b]);
    expect(parsed.ok && Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value.packs)).toBe(true);
  });

  test("parsing parsed packs gives them back", () => {
    const parsed = SelectedPacks.parse([a]);
    expect(parsed.ok && SelectedPacks.parse(parsed.value)).toEqual(parsed);
  });

  const refusals: [string, unknown, string][] = [
    ["something that is not a list", "a", "Compose takes a list of available packs and a list of selected packs"],
    ["a pack not built with definePack", [{ __brand: "Pack", id: "test-packs/plain" }], notBuilt("test-packs/plain")],
    ["something that is not a pack at all", [7], notBuilt("7")],
    ["a pack selected twice", [b, a, b], "Pack 'test-packs/b' is selected twice. Select each pack once"],
  ];
  for (const [title, raw, error] of refusals) {
    test(`refuses ${title}`, () => {
      expect(SelectedPacks.parse(raw)).toEqual({ ok: false, error });
    });
  }
});
