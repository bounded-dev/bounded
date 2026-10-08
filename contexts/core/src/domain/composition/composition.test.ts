import { describe, expect, test } from "bun:test";
import { type BasePack, contribution, definePack, point, pointGroup } from "../packs/pack.ts";
import { portKeysFor } from "../lifecycle/port-key.ts";
import { packIdsFor } from "../packs/pack-id.ts";
import type { Result } from "../shared/result.ts";
import type { Composition as CompositionContract } from "./composition.contract.ts";
import { Composition } from "./composition.ts";

/** A point's check parses an untyped value into its value type, normalising it. */
function word(raw: unknown): Result<string> {
  return typeof raw === "string" && raw.trim() !== "" ? { ok: true, value: raw.trim() } : { ok: false, error: "a word is a non-empty string" };
}
const anything = (raw: unknown): Result<unknown> => ({ ok: true, value: raw });
const packId = packIdsFor("test-packs");

// "base" declares an extension point for words and gives it one of its own;
// "ext" depends on base and adds more; "other" is unrelated.
const base = definePack({
  id: packId("base"),
  points: {
    words: point({ description: "Words any dependent pack may add", check: word, values: ["alpha"] }),
  },
});
const { words } = base.points;
const ext = definePack({ id: packId("ext"), dependsOn: [base], contributes: [contribution(words, ["beta", " gamma "])] });
const other = definePack({ id: packId("other") });

function composed(available: readonly BasePack[], selected: readonly BasePack[]): CompositionContract {
  const result = Composition.compose(available, selected);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** A pack built from untyped data at run time, where the compiler checks nothing. */
function untypedPack(spec: object): BasePack {
  return (definePack as unknown as (spec: object) => BasePack)(spec);
}

/** A pack `test-packs/<local>` that depends on base (and `more`) and adds `values` to its words. */
function wordsPack(local: string, more: readonly BasePack[], values: string[]): BasePack {
  return untypedPack({ id: `test-packs/${local}`, dependsOn: [base, ...more], contributes: [contribution(words, values)] });
}

const ids = (packs: readonly BasePack[]): string[] => packs.map((pack) => pack.id.value);
const malformed = (what: string) => `Pack 'test-packs/bad' is malformed: ${what}. Fix its definition`;
const keyRefusal = (key: string) => malformed(`its point key '${key}' must be a camelCase word, such as 'protectedPaths'`);

describe("Composition — finding a pack's own point", () => {
  test("gives the point a selected pack made from a declaration, typed by it; none for another declaration or an unselected pack", () => {
    const declared = point({ description: "Words", check: word });
    const owner = definePack({ id: packId("owner"), points: { words: declared } });
    const composition = composed([owner, base], [owner]);
    expect(composition.pointDeclaredBy(declared)).toBe(owner.points.words);
    expect(composition.pointDeclaredBy(point({ description: "Words", check: word }))).toBeUndefined();
    expect(composed([owner, base], [base]).pointDeclaredBy(declared)).toBeUndefined();
  });

  test("a declaration reused for a second point, in this pack or another, is refused: each point is declared once, so it is found by its declaration alone", () => {
    const declared = point({ description: "Words", check: word });
    const first = definePack({ id: packId("first"), points: { words: declared } });
    const second = definePack({ id: packId("second"), points: { words: declared } });
    expect(Composition.compose([first, second], [first, second])).toEqual({
      ok: false,
      error: "Pack 'test-packs/second' declares extension point 'test-packs/second.words' with the declaration of 'test-packs/first.words'. Declare each point with its own point(...)",
    });
    const twice = definePack({ id: packId("twice"), points: { words: declared, more: declared } });
    expect(Composition.compose([twice], [twice])).toEqual({
      ok: false,
      error: "Pack 'test-packs/twice' declares extension point 'test-packs/twice.more' with the declaration of 'test-packs/twice.words'. Declare each point with its own point(...)",
    });
  });
});

describe("Composition — the ports its packs need", () => {
  test("lists the selected packs' ports in composition order; an unselected pack leaves no trace", () => {
    const [aFiles, bFiles] = [portKeysFor(packId("a"))("files"), portKeysFor(packId("b"))("files")];
    const a = definePack({ id: packId("a"), ports: { files: aFiles } });
    const b = definePack({ id: packId("b"), dependsOn: [a], ports: { files: bFiles } });
    const c = definePack({ id: packId("c"), ports: { files: portKeysFor(packId("c"))("files") } });
    expect(composed([b, a, c], [b, a]).requiredPorts()).toEqual([aFiles, bFiles]);
    expect(composed([base], [base]).requiredPorts()).toEqual([]);
  });
});

describe("Composition — reading an extension point", () => {
  test("returns every value, typed and as its check stored it, dependencies' before dependents'", () => {
    const composition = composed([ext, base], [ext, base]);
    expect(ids(composition.packs)).toEqual(["test-packs/base", "test-packs/ext"]);
    const read = composition.read(words);
    expect(read).toEqual({ ok: true, value: ["alpha", "beta", "gamma"] });
    expect(read.ok && read.value.map((word) => word.toUpperCase())).toEqual(["ALPHA", "BETA", "GAMMA"]);
  });

  test("entries say which pack each value came from", () => {
    expect(composed([ext, base], [ext, base]).entries(words)).toEqual({
      ok: true,
      value: [
        { fromPackId: base.id, value: "alpha" },
        { fromPackId: ext.id, value: "beta" },
        { fromPackId: ext.id, value: "gamma" },
      ],
    });
    expect(composed([base, other], [other]).entries(words).ok).toBe(false);
  });

  test("never depends on the order packs were listed in", () => {
    const b = wordsPack("b", [], ["b"]);
    const a = wordsPack("a", [b], ["a"]);
    const c = wordsPack("c", [], ["c"]);
    const one = composed([a, b, c, base], [a, b, c, base]);
    const two = composed([base, c, b, a], [base, c, b, a]);
    expect(ids(one.packs)).toEqual(["test-packs/base", "test-packs/b", "test-packs/a", "test-packs/c"]);
    expect(two.packs).toEqual(one.packs);
    expect(two.read(words)).toEqual({ ok: true, value: ["alpha", "b", "a", "c"] });
  });

  test("a pack that is not selected leaves no trace", () => {
    expect(composed([base, ext], [base]).read(words)).toEqual({ ok: true, value: ["alpha"] });
    expect(composed([base, other], [other]).read(words)).toEqual({
      ok: false,
      error: "Extension point 'test-packs/base.words' does not exist in this composition: its owner 'test-packs/base' is not selected. Select it to use the point",
    });
  });

  test("reading the point of another pack with the selected one's id is refused", () => {
    const twin = definePack({ id: packId("base"), points: { words: point({ description: "Not the real one", check: anything }) } });
    expect(composed([base], [base]).read(twin.points.words)).toEqual({
      ok: false,
      error: "Extension point 'test-packs/base.words' belongs to a pack with the id 'test-packs/base' that is not the selected one (another pack with that id, or another copy of it). Read the point of the selected pack",
    });
  });

  test("a dependency cycle cannot be built: a pack depends on packs that already exist, and is frozen", () => {
    expect(Object.isFrozen(ext)).toBe(true);
    expect(Object.isFrozen(ext.dependsOn)).toBe(true);
    expect(Object.isFrozen(base.points)).toBe(true);
  });

  test("a point keyed __proto__ is an ordinary key, refused as not camelCase, never a prototype", () => {
    const sneaky = untypedPack({ id: "test-packs/bad", points: JSON.parse('{"__proto__": null}') });
    expect(Object.keys(sneaky.points)).toEqual(["__proto__"]);
  });
});

describe("Composition — every refusal names the pack, the extension point and the fix", () => {
  const twinBase = definePack({ id: packId("base") });
  const notBuilt = (which: string, id: string) =>
    `${which} pack '${id}' was not built with definePack(...), or was built by a different copy of bounded. Build every pack with definePack from one copy`;
  const COPY = "by this copy of bounded";
  const plain = { __brand: "Pack", id: "test-packs/plain", dependsOn: [], points: {}, contributes: [] } as unknown as BasePack;

  const refusals: [string, readonly BasePack[], readonly BasePack[], string][] = [
    ["a selected pack that is not available", [base], [base, other],
      "Pack 'test-packs/other' is listed but not available. Make it available, or remove it from the list"],
    ["a pack selected twice", [base], [base, base],
      "Pack 'test-packs/base' is listed twice. List each pack once"],
    ["a selected pack not built with definePack", [base], [plain], notBuilt("Selected", "test-packs/plain")],
    ["a dependency that is not available", [ext], [ext],
      "Pack 'test-packs/ext' depends on pack 'test-packs/base', which is not available. Add 'test-packs/base' to the available packs, or remove the dependency"],
    ["a dependency that is another pack with the selected one's id", [twinBase, ext], [twinBase, ext],
      "Two different packs have the id 'test-packs/base': one listed, and one that 'test-packs/ext' depends on. They are two copies of one package, or two packs given one id; make every pack use the same one"],
    ["a dependency whose id the available pack has, but which is another pack", [twinBase, ext], [ext],
      "Pack 'test-packs/ext' depends on a pack with the id 'test-packs/base' that is not the available one (another pack with that id, or another copy of it). Make the pack it depends on available instead"],
    ["two packs with the same id", [base, twinBase], [base],
      "Two available packs have the id 'test-packs/base'. An id names one pack in selections and messages: give each pack its own"],
    ["duplicate ids, reported in id order whatever the listing order",
      [definePack({ id: packId("b") }), definePack({ id: packId("b") }), definePack({ id: packId("a") }), definePack({ id: packId("a") })], [],
      "Two available packs have the id 'test-packs/a'. An id names one pack in selections and messages: give each pack its own"],
    ["an available pack whose id is not a pack id", [untypedPack({ id: "Bad Label" })], [],
      "Available pack 'Bad Label' has an invalid id: Pack id 'Bad Label' must be an npm package name, '/', and lowercase words joined by hyphens, such as 'bounded/path-gate'. Give it an id from packIdsFor(...)"],
    ["a point declared on another pack's behalf", [untypedPack({ id: "test-packs/bad", points: { stolen: words } })], [],
      malformed(`its points must each be declared with point(...) ${COPY}`)],
    ["a point declared without a check", [untypedPack({ id: "test-packs/bad", points: { loose: point({ description: "No check" } as never) } })], [],
      malformed("its point 'loose' has no check: every point parses the values it accepts")],
    ["a point group inside a point group",
      [untypedPack({ id: "test-packs/bad", points: { outer: pointGroup({ inner: pointGroup({ deep: point({ description: "Deep", check: anything }) }) } as never) } })], [],
      malformed("its point 'outer.inner' is a group inside a group: groups of points are one level deep")],
    ["a group member whose key is not camelCase",
      [untypedPack({ id: "test-packs/bad", points: { outer: pointGroup({ "a.b": point({ description: "Dotted", check: anything }) } as never) } })], [],
      malformed("its point key 'outer.a.b' must be a camelCase word, such as 'protectedPaths'")],
    ["a group member that is not a genuine point declaration",
      [untypedPack({ id: "test-packs/bad", points: { outer: pointGroup({ forged: { __brand: "PointDeclaration", description: "Forged", check: anything } } as never) } })], [],
      malformed(`its points must each be declared with point(...) ${COPY}`)],
    ["a contribution across an undeclared dependency that reaches composition anyway",
      [base, untypedPack({ id: "test-packs/rogue", contributes: [contribution(words, ["x"])] })], [],
      "Pack 'test-packs/rogue' contributes to extension point 'test-packs/base.words', owned by pack 'test-packs/base', but does not depend on it. Add 'test-packs/base' to its dependencies, or remove the contribution"],
    ["a contribution through a transitive dependency only",
      [base, ext, untypedPack({ id: "test-packs/top", dependsOn: [ext], contributes: [contribution(words, ["x"])] })], [],
      "Pack 'test-packs/top' contributes to extension point 'test-packs/base.words', owned by pack 'test-packs/base', but does not depend on it. Add 'test-packs/base' to its dependencies, or remove the contribution"],
    ["a contribution that is not a genuine contribution, whatever it claims",
      [base, untypedPack({ id: "test-packs/bad", dependsOn: [base], contributes: [{ __brand: "Contribution", point: words, values: [42, ""] }] })], [],
      malformed(`its contributes must be a list of contributions made with contribution(...) ${COPY}`)],
    ["dependencies that are not a list", [untypedPack({ id: "test-packs/bad", dependsOn: 5 })], [],
      malformed(`its dependsOn must be a list of packs made with definePack(...) ${COPY}`)],
    ["dependencies given by id, not as packs", [base, untypedPack({ id: "test-packs/bad", dependsOn: ["test-packs/base"] })], [],
      malformed(`its dependsOn must be a list of packs made with definePack(...) ${COPY}`)],
    ["a dependency listed twice", [base, untypedPack({ id: "test-packs/bad", dependsOn: [base, base] })], [],
      malformed("it lists 'test-packs/base' twice in dependsOn")],
    ["an available pack not built with definePack", [base, plain], [base], notBuilt("Available", "test-packs/plain")],
    ["a forged pack copied from a genuine one", [base, { ...other, id: "test-packs/forged" } as unknown as BasePack], [base], notBuilt("Available", "test-packs/forged")],
    ["an invalid contributed value",
      [base, definePack({ id: packId("ext"), dependsOn: [base], contributes: [contribution(words, ["ok", " "])] })], [],
      "Pack 'test-packs/ext' contributes an invalid value to extension point 'test-packs/base.words': a word is a non-empty string. Fix the value, or remove the contribution"],
    ["a value of the wrong type from untyped data, refused by the point's check",
      [base, untypedPack({ id: "test-packs/bad", dependsOn: [base], contributes: [contribution(words, [42 as unknown as string])] })], [],
      "Pack 'test-packs/bad' contributes an invalid value to extension point 'test-packs/base.words': a word is a non-empty string. Fix the value, or remove the contribution"],
    ["an invalid value the owner gives its own point",
      [definePack({ id: packId("base"), points: { words: point({ description: "Words", check: (): Result<string> => ({ ok: false, error: "no" }), values: ["x"] }) } })], [],
      "Pack 'test-packs/base' contributes an invalid value to extension point 'test-packs/base.words': no. Fix the value, or remove the contribution"],
    ["a check that accepts without returning a value",
      [definePack({ id: packId("base"), points: { words: point({ description: "Words", check: () => ({ ok: true }) as unknown as Result<string>, values: ["x"] }) } })], [],
      "Pack 'test-packs/base' contributes an invalid value to extension point 'test-packs/base.words': its check returned no result. Fix the value, or remove the contribution"],
  ];

  for (const [title, available, selected, message] of refusals) {
    test(title, () => {
      // Rows that select nothing select every available pack.
      expect(Composition.compose(available, selected.length === 0 ? available : selected)).toEqual({ ok: false, error: message });
    });
  }

  test("point keys that could collide with the id scheme are refused", () => {
    const dotted = untypedPack({ id: "test-packs/bad", points: { "a.b": point({ description: "Dotted", check: anything }) } });
    const proto = untypedPack({ id: "test-packs/bad", points: JSON.parse('{"__proto__": 1}') });
    expect(Composition.compose([dotted], [dotted])).toEqual({ ok: false, error: keyRefusal("a.b") });
    expect(Composition.compose([proto], [proto])).toEqual({ ok: false, error: keyRefusal("__proto__") });
  });

  test("garbage instead of lists is refused, never thrown", () => {
    const refusal = { ok: false as const, error: "Compose takes a list of available packs and a list of selected packs" };
    expect(Composition.compose(null as unknown as BasePack[], [])).toEqual(refusal);
    expect(Composition.compose([], "base" as unknown as BasePack[])).toEqual(refusal);
    expect(Composition.compose([null as unknown as BasePack], [])).toEqual({ ok: false, error: notBuilt("Available", "null") });
    expect(Composition.compose([base], [7 as unknown as BasePack])).toEqual({ ok: false, error: notBuilt("Selected", "7") });
  });

  test("the same faults give the same refusal whatever the listing order", () => {
    const zed = definePack({ id: packId("zed") });
    const one = Composition.compose([ext, base, other], [ext, zed, other]);
    const two = Composition.compose([other, base, ext], [other, zed, ext]);
    expect(one).toEqual(two);
    expect(one).toEqual({ ok: false, error: "Pack 'test-packs/zed' is listed but not available. Make it available, or remove it from the list" });
  });

  test("a check that throws refuses the value instead of letting it through", () => {
    const fragile = definePack({
      id: packId("base"),
      points: {
        words: point({
          description: "Its check throws",
          check: (): Result<string> => {
            throw new Error("boom");
          },
          values: ["x"],
        }),
      },
    });
    expect(Composition.compose([fragile], [fragile])).toEqual({
      ok: false,
      error: "Pack 'test-packs/base' contributes an invalid value to extension point 'test-packs/base.words': its check failed (boom). Fix the value, or remove the contribution",
    });
  });

  test("an unselected pack's faults are not checked", () => {
    const broken = untypedPack({ id: "test-packs/broken", dependsOn: [other], contributes: [contribution(words, [""])] });
    expect(ids(composed([base, broken], [base]).packs)).toEqual(["test-packs/base"]);
  });
});

describe("Composition — a selection brings in its packs' dependencies", () => {
  const top = definePack({ id: packId("top"), dependsOn: [ext] });

  test("a listed pack's dependencies, and theirs, are selected with it: their points exist and their values are read", () => {
    const composition = composed([base, ext, top], [top]);
    expect(ids(composition.packs)).toEqual(["test-packs/base", "test-packs/ext", "test-packs/top"]);
    expect(composition.read(words)).toEqual({ ok: true, value: ["alpha", "beta", "gamma"] });
  });

  test("the composition order is the same whether a dependency is listed or brought in", () => {
    const broughtIn = composed([base, ext, top], [top]);
    const listed = composed([base, ext, top], [top, ext, base]);
    expect(broughtIn.packs).toEqual(listed.packs);
    expect(broughtIn.read(words)).toEqual(listed.read(words));
  });

  test("a brought-in pack's ports are required", () => {
    const [aFiles, bFiles] = [portKeysFor(packId("a"))("files"), portKeysFor(packId("b"))("files")];
    const a = definePack({ id: packId("a"), ports: { files: aFiles } });
    const b = definePack({ id: packId("b"), dependsOn: [a], ports: { files: bFiles } });
    expect(composed([a, b], [b]).requiredPorts()).toEqual([aFiles, bFiles]);
  });

  test("a brought-in pack that is malformed is refused, as a listed one is", () => {
    const bad = untypedPack({ id: "test-packs/bad", points: { "a.b": point({ description: "Dotted", check: anything }) } });
    const usesBad = untypedPack({ id: "test-packs/uses-bad", dependsOn: [bad] });
    expect(Composition.compose([bad, usesBad], [usesBad])).toEqual({ ok: false, error: keyRefusal("a.b") });
  });

  test("a pack neither listed nor needed by a selected pack leaves no trace", () => {
    const unused = definePack({ id: packId("unused"), points: { words: point({ description: "Unused", check: word }) } });
    const composition = composed([base, ext, unused], [ext]);
    expect(ids(composition.packs)).toEqual(["test-packs/base", "test-packs/ext"]);
    expect(composition.entries(unused.points.words)).toEqual({
      ok: false,
      error: "Extension point 'test-packs/unused.words' does not exist in this composition: its owner 'test-packs/unused' is not selected. Select it to use the point",
    });
  });
});
