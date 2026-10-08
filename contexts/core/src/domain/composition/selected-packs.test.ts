import { describe, expect, test } from "bun:test";
import type { Result } from "../shared/result.ts";
import { type BasePack, definePack, point } from "../packs/pack.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import { SelectedPacks } from "./selected-packs.ts";

const packId = packIdsFor("test-packs");
const a = definePack({ id: packId("a") });
const b = definePack({ id: packId("b") });
const base = definePack({ id: packId("base") });
const ext = definePack({ id: packId("ext"), dependsOn: [base] });
const top = definePack({ id: packId("top"), dependsOn: [ext] });
const twinBase = definePack({ id: packId("base") });
const anything = (raw: unknown): Result<unknown> => ({ ok: true, value: raw });

/** A pack built from untyped data at run time, where the compiler checks nothing. */
function untypedPack(spec: object): BasePack {
  return (definePack as unknown as (spec: object) => BasePack)(spec);
}

/** Pack lists compared element by element by identity: toEqual cannot tell a pack from another copy of it. */
function expectSamePacks(actual: readonly BasePack[] | false | undefined, expected: readonly BasePack[]): void {
  expect(Array.isArray(actual) ? actual.map((pack) => pack.id.value) : actual).toEqual(expected.map((pack) => pack.id.value));
  for (const [i, pack] of expected.entries()) expect(actual !== false && actual?.[i]).toBe(pack);
}

/** The refusal of two different pack objects with one id, naming where each comes from. */
const TWIN = (id: string, first: string, second: string) =>
  `Two different packs have the id '${id}': ${first}, and ${second}. They are two copies of one package, or two packs given one id; make every pack use the same one`;

const notBuilt = (id: string) => `Listed pack '${id}' was not built with definePack(...), or was built by a different copy of bounded. Build every pack with definePack from one copy`;

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
    ["something that is not a list", "a", "Compose takes a list of available packs and a list of listed packs"],
    ["a pack not built with definePack", [{ __brand: "Pack", id: "test-packs/plain" }], notBuilt("test-packs/plain")],
    ["something that is not a pack at all", [7], notBuilt("7")],
    ["a pack selected twice", [b, a, b], "Pack 'test-packs/b' is listed twice. List each pack once"],
  ];
  for (const [title, raw, error] of refusals) {
    test(`refuses ${title}`, () => {
      expect(SelectedPacks.parse(raw)).toEqual({ ok: false, error });
    });
  }

  test("brings in every pack the listed packs depend on, transitively, in id order", () => {
    const parsed = SelectedPacks.parse([top]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expectSamePacks(parsed.value.packs, [base, ext, top]);
    expectSamePacks(parsed.value.listedPacks, [top]);
    expect(Object.isFrozen(parsed.value.listedPacks)).toBe(true);
  });

  test("a pack both listed and depended on is selected once", () => {
    const one = SelectedPacks.parse([ext, base]);
    expectSamePacks(one.ok && one.value.packs, [base, ext]);
    const two = SelectedPacks.parse([top, base]);
    expectSamePacks(two.ok && two.value.packs, [base, ext, top]);
    expectSamePacks(two.ok && two.value.listedPacks, [base, top]);
  });

  test("two different packs with one id in the selection are refused, naming where each comes from, whatever the listing order", () => {
    const extOfTwin = definePack({ id: packId("ext"), dependsOn: [twinBase] });
    const dependsOnBase = definePack({ id: packId("a"), dependsOn: [base] });
    const dependsOnTwin = definePack({ id: packId("b"), dependsOn: [twinBase] });
    const listedAndDependedOn = { ok: false as const, error: TWIN("test-packs/base", "one listed", "one that 'test-packs/ext' depends on") };
    expect(SelectedPacks.parse([base, extOfTwin])).toEqual(listedAndDependedOn);
    expect(SelectedPacks.parse([extOfTwin, base])).toEqual(listedAndDependedOn);
    const bothDependedOn = { ok: false as const, error: TWIN("test-packs/base", "one that 'test-packs/a' depends on", "one that 'test-packs/b' depends on") };
    expect(SelectedPacks.parse([dependsOnBase, dependsOnTwin])).toEqual(bothDependedOn);
    expect(SelectedPacks.parse([dependsOnTwin, dependsOnBase])).toEqual(bothDependedOn);
    expect(SelectedPacks.parse([base, twinBase])).toEqual({ ok: false, error: TWIN("test-packs/base", "one listed", "another listed") });
  });

  test("when several ids have two packs, the smallest id is reported", () => {
    const zed = definePack({ id: packId("zed") });
    const zedCopy = definePack({ id: packId("zed") });
    const refusal = { ok: false as const, error: TWIN("test-packs/base", "one listed", "another listed") };
    expect(SelectedPacks.parse([zed, zedCopy, base, twinBase])).toEqual(refusal);
    expect(SelectedPacks.parse([twinBase, base, zedCopy, zed])).toEqual(refusal);
  });

  test("three or more packs with one id are all named, listed first, then by the pack that depends on each", () => {
    const thirdBase = definePack({ id: packId("base") });
    const dependsOnTwin = definePack({ id: packId("a"), dependsOn: [twinBase] });
    const dependsOnThird = definePack({ id: packId("b"), dependsOn: [thirdBase] });
    const refusal = {
      ok: false as const,
      error: "Two different packs have the id 'test-packs/base': one listed, one that 'test-packs/a' depends on, and one that 'test-packs/b' depends on. They are two copies of one package, or two packs given one id; make every pack use the same one",
    };
    expect(SelectedPacks.parse([base, dependsOnTwin, dependsOnThird])).toEqual(refusal);
    expect(SelectedPacks.parse([dependsOnThird, dependsOnTwin, base])).toEqual(refusal);
    expect(SelectedPacks.parse([base, twinBase, thirdBase])).toEqual({
      ok: false,
      error: "Two different packs have the id 'test-packs/base': one listed, another listed, and another listed. They are two copies of one package, or two packs given one id; make every pack use the same one",
    });
  });

  test("two packs with one id that one pack depends on are named as one and another", () => {
    const dependsOnBoth = untypedPack({ id: "test-packs/both", dependsOn: [base, twinBase] });
    expect(SelectedPacks.parse([dependsOnBoth])).toEqual({
      ok: false,
      error: "Two different packs have the id 'test-packs/base': one that 'test-packs/both' depends on, and another that 'test-packs/both' depends on. They are two copies of one package, or two packs given one id; make every pack use the same one",
    });
  });

  test("a malformed pack's dependencies are not followed, and a malformed dependency is still selected, for composition to refuse", () => {
    const odd = untypedPack({ id: "test-packs/odd", dependsOn: 5 });
    const bad = untypedPack({ id: "test-packs/bad", points: { "a.b": point({ description: "Dotted", check: anything }) } });
    const usesBad = untypedPack({ id: "test-packs/uses-bad", dependsOn: [bad] });
    const parsedOdd = SelectedPacks.parse([odd]);
    expectSamePacks(parsedOdd.ok && parsedOdd.value.packs, [odd]);
    const parsedUsesBad = SelectedPacks.parse([usesBad]);
    expectSamePacks(parsedUsesBad.ok && parsedUsesBad.value.packs, [bad, usesBad]);
  });
});
