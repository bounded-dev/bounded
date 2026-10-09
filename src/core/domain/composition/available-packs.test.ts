import { describe, expect, test } from "bun:test";
import type { BasePack } from "../packs/pack.contract.ts";
import { definePack } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import { AvailablePacks } from "./available-packs.ts";

const packId = packIdsFor("test-packs");
const a = definePack({ id: packId("a") });
const b = definePack({ id: packId("b") });
const untypedPack = (spec: object): BasePack => (definePack as unknown as (spec: object) => BasePack)(spec);
const notBuilt = (id: string) => `Available pack '${id}' was not built with definePack(...), or was built by a different copy of bounded. Build every pack with definePack from one copy`;

describe("AvailablePacks — the packs a selection may choose from", () => {
  test("a list of packs definePack made, each with an id of its own, in the order given", () => {
    const parsed = AvailablePacks.parse([b, a]);
    expect(parsed.ok && parsed.value.packs).toEqual([b, a]);
    expect(parsed.ok && parsed.value.includes(a)).toBe(true);
    expect(parsed.ok && parsed.value.includes(definePack({ id: packId("c") }))).toBe(false);
    expect(parsed.ok && Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value.packs)).toBe(true);
  });

  test("parsing parsed packs gives them back", () => {
    const parsed = AvailablePacks.parse([a]);
    expect(parsed.ok && AvailablePacks.parse(parsed.value)).toEqual(parsed);
  });

  const refusals: [string, unknown, string][] = [
    ["something that is not a list", "a", "Compose takes a list of available packs and a list of listed packs"],
    ["a pack not built with definePack", [a, { __brand: "Pack", id: "test-packs/plain" }], notBuilt("test-packs/plain")],
    ["a copy of a pack", [{ ...a }], notBuilt("test-packs/a")],
    ["something that is not a pack at all", [null], notBuilt("null")],
    ["a pack whose id is not a pack id", [untypedPack({ id: "Bad Label" })],
      "Available pack 'Bad Label' has an invalid id: Pack id 'Bad Label' must be an npm package name, '/', and lowercase words joined by hyphens, such as 'bounded/protected-paths'. Give it an id from packIdsFor(...)"],
    ["two packs with the same id, reported in id order", [definePack({ id: packId("b") }), b, definePack({ id: packId("a") }), a],
      "Two available packs have the id 'test-packs/a'. An id names one pack in selections and messages: give each pack its own"],
  ];
  for (const [title, raw, error] of refusals) {
    test(`refuses ${title}`, () => {
      expect(AvailablePacks.parse(raw)).toEqual({ ok: false, error });
    });
  }
});
