import { describe, expect, test } from "bun:test";
import { type AnyPack, contribution, definePack, point } from "../packs/pack.ts";
import type { Result } from "../shared/result.ts";
import type { Composition as CompositionContract } from "./composition.contract.ts";
import { Composition } from "./composition.ts";

/** A point's check parses an untyped value into its value type, normalising it. */
function word(raw: unknown): Result<string> {
  return typeof raw === "string" && raw.trim() !== "" ? { ok: true, value: raw.trim() } : { ok: false, error: "a word is a non-empty string" };
}
const anything = (raw: unknown): Result<unknown> => ({ ok: true, value: raw });

// "base" declares an extension point for words and gives it one of its own;
// "ext" depends on base and adds more; "other" is unrelated.
const base = definePack({
  id: "base",
  points: {
    words: point({ description: "Words any dependent pack may add", check: word, values: ["alpha"] }),
  },
});
const { words } = base.points;
const ext = definePack({ id: "ext", dependsOn: [base], contributes: [contribution(words, ["beta", " gamma "])] });
const other = definePack({ id: "other" });

function composed(available: readonly AnyPack[], selected: readonly string[]): CompositionContract {
  const result = Composition.compose(available, selected);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** A pack built from untyped data at run time, where the compiler checks nothing. */
function untypedPack(spec: object): AnyPack {
  return (definePack as unknown as (spec: object) => AnyPack)(spec);
}

/** A pack labelled `id` that depends on base (and `more`) and adds `values` to its words. */
function wordsPack(id: string, more: readonly AnyPack[], values: string[]): AnyPack {
  return untypedPack({ id, dependsOn: [base, ...more], contributes: [contribution(words, values)] });
}

describe("Composition — reading an extension point", () => {
  test("returns every value, typed and as its check stored it, dependencies' before dependents'", () => {
    const composition = composed([ext, base], ["ext", "base"]);
    expect(composition.packs).toEqual(["base", "ext"]);
    const read = composition.read(words);
    expect(read).toEqual({ ok: true, value: ["alpha", "beta", "gamma"] });
    expect(read.ok && read.value.map((word) => word.toUpperCase())).toEqual(["ALPHA", "BETA", "GAMMA"]);
  });

  test("never depends on the order packs were listed in", () => {
    const b = wordsPack("b", [], ["b"]);
    const a = wordsPack("a", [b], ["a"]);
    const c = wordsPack("c", [], ["c"]);
    const one = composed([a, b, c, base], ["a", "b", "c", "base"]);
    const two = composed([base, c, b, a], ["base", "c", "b", "a"]);
    expect(one.packs).toEqual(["base", "b", "a", "c"]);
    expect(two.packs).toEqual(one.packs);
    expect(two.read(words)).toEqual({ ok: true, value: ["alpha", "b", "a", "c"] });
  });

  test("a pack that is not selected leaves no trace", () => {
    expect(composed([base, ext], ["base"]).read(words)).toEqual({ ok: true, value: ["alpha"] });
    expect(composed([base, other], ["other"]).read(words)).toEqual({
      ok: false,
      error: "Extension point 'base.words' does not exist in this composition: its owner 'base' is not selected. Select 'base' to use it",
    });
  });

  test("reading the point of another pack with the selected one's label is refused", () => {
    const twin = definePack({ id: "base", points: { words: point({ description: "Not the real one", check: anything }) } });
    expect(composed([base], ["base"]).read(twin.points.words)).toEqual({
      ok: false,
      error: "Extension point 'base.words' belongs to a pack labelled 'base' that is not the selected 'base' (another pack with that label, or another copy of it). Read the point of the selected pack",
    });
  });

  test("a dependency cycle cannot be built: a pack depends on packs that already exist, and is frozen", () => {
    expect(Object.isFrozen(ext)).toBe(true);
    expect(Object.isFrozen(ext.dependsOn)).toBe(true);
    expect(Object.isFrozen(base.points)).toBe(true);
  });
});

describe("Composition — every refusal names the pack, the extension point and the fix", () => {
  const twinBase = definePack({ id: "base" });
  const notBuilt = (label: string) =>
    `Available pack '${label}' was not built with definePack(...), or was built by a different copy of @bounded/core. Build every pack with definePack from one copy`;
  const malformed = (what: string) => `Pack 'bad' is malformed: ${what}. Fix its definition`;

  const refusals: [string, readonly AnyPack[], readonly string[], string][] = [
    ["a selected pack that is not available", [base], ["base", "nope"],
      "Pack 'nope' is selected but not available. Make it available, or remove it from the selection"],
    ["a pack selected twice", [base], ["base", "base"],
      "Pack 'base' is selected twice. Select each pack once"],
    ["a selected name that is not a pack name", [base], ["base", "Bad"],
      "Pack name 'Bad' must be lowercase words joined by single hyphens, such as 'path-gate'"],
    ["a selected pack whose dependency is not selected", [base, ext], ["ext"],
      "Pack 'ext' depends on pack 'base', which is not selected. Select 'base' as well, or remove the dependency"],
    ["a dependency that is another pack with the selected one's label", [twinBase, ext], ["base", "ext"],
      "Pack 'ext' depends on a pack labelled 'base' that is not the available 'base' (another pack with that label, or another copy of it). Make the pack it depends on available instead"],
    ["two packs with the same name", [base, twinBase], ["base"],
      "Two available packs are labelled 'base'. A label names a pack in selections and messages: rename one of them"],
    ["duplicate names, reported by name order whatever the listing order",
      [definePack({ id: "b" }), definePack({ id: "b" }), definePack({ id: "a" }), definePack({ id: "a" })], ["a"],
      "Two available packs are labelled 'a'. A label names a pack in selections and messages: rename one of them"],
    ["an available pack whose label is not a pack name", [untypedPack({ id: "Bad Label" })], [],
      "Available pack 'Bad Label' has an invalid label: Pack name 'Bad Label' must be lowercase words joined by single hyphens, such as 'path-gate'. Give it a valid id, such as 'path-gate'"],
    ["an extension point key that could collide with the label scheme", [untypedPack({ id: "bad", points: { "a.b": point({ description: "Dotted", check: anything }) } })], ["bad"],
      malformed("its point key 'a.b' must be a camelCase word, such as 'protectedPaths'")],
    ["a point declared on another pack's behalf", [untypedPack({ id: "bad", points: { stolen: words } })], ["bad"],
      malformed("its points must each be declared with point(...) by this copy of @bounded/core")],
    ["a contribution across an undeclared dependency that reaches composition anyway",
      [base, untypedPack({ id: "rogue", contributes: [contribution(words, ["x"])] })], ["base", "rogue"],
      "Pack 'rogue' contributes to extension point 'base.words', owned by pack 'base', but does not depend on 'base'. Add 'base' to the dependencies of 'rogue', or remove the contribution"],
    ["a contribution through a transitive dependency only",
      [base, ext, untypedPack({ id: "top", dependsOn: [ext], contributes: [contribution(words, ["x"])] })], ["base", "ext", "top"],
      "Pack 'top' contributes to extension point 'base.words', owned by pack 'base', but does not depend on 'base'. Add 'base' to the dependencies of 'top', or remove the contribution"],
    ["a contribution that is not a genuine contribution, whatever it claims",
      [base, untypedPack({ id: "bad", dependsOn: [base], contributes: [{ __brand: "Contribution", point: words, values: [42, ""] }] })], ["base", "bad"],
      malformed("its contributes must be a list of contributions made with contribution(...) by this copy of @bounded/core")],
    ["dependencies that are not a list", [untypedPack({ id: "bad", dependsOn: 5 })], ["bad"],
      malformed("its dependsOn must be a list of packs made with definePack(...) by this copy of @bounded/core")],
    ["dependencies given by label, not as packs", [base, untypedPack({ id: "bad", dependsOn: ["base"] })], ["base", "bad"],
      malformed("its dependsOn must be a list of packs made with definePack(...) by this copy of @bounded/core")],
    ["an available pack not built with definePack", [base, { __brand: "Pack", id: "plain", dependsOn: [], points: {}, contributes: [] } as unknown as AnyPack], ["base"],
      notBuilt("plain")],
    ["a forged pack copied from a genuine one", [base, { ...other, id: "forged" }], ["base"], notBuilt("forged")],
    ["an invalid contributed value",
      [base, definePack({ id: "ext", dependsOn: [base], contributes: [contribution(words, ["ok", " "])] })], ["base", "ext"],
      "Pack 'ext' contributes an invalid value to extension point 'base.words': a word is a non-empty string. Fix the value, or remove the contribution"],
    ["a value of the wrong type from untyped data, refused by the point's check",
      [base, untypedPack({ id: "bad", dependsOn: [base], contributes: [contribution(words, [42 as unknown as string])] })], ["base", "bad"],
      "Pack 'bad' contributes an invalid value to extension point 'base.words': a word is a non-empty string. Fix the value, or remove the contribution"],
    ["a dependency listed twice", [base, untypedPack({ id: "bad", dependsOn: [base, base] })], ["base", "bad"],
      malformed("it lists 'base' twice in dependsOn")],
    ["a point declared without a check", [untypedPack({ id: "bad", points: { loose: point({ description: "No check" } as never) } })], ["bad"],
      malformed("its point 'loose' has no check: every point parses the values it accepts")],
    ["an invalid value the owner gives its own point",
      [definePack({ id: "base", points: { words: point({ description: "Words", check: (): Result<string> => ({ ok: false, error: "no" }), values: ["x"] }) } })], ["base"],
      "Pack 'base' contributes an invalid value to extension point 'base.words': no. Fix the value, or remove the contribution"],
  ];

  for (const [title, available, selected, message] of refusals) {
    test(title, () => {
      expect(Composition.compose(available, selected)).toEqual({ ok: false, error: message });
    });
  }

  test("garbage instead of lists is refused, never thrown", () => {
    const refusal = { ok: false as const, error: "Compose takes a list of available packs and a list of selected pack names" };
    expect(Composition.compose(null as unknown as AnyPack[], [])).toEqual(refusal);
    expect(Composition.compose([], "base" as unknown as string[])).toEqual(refusal);
    expect(Composition.compose([null as unknown as AnyPack], [])).toEqual({ ok: false, error: notBuilt("null") });
    expect(Composition.compose([base], [7 as unknown as string])).toEqual({ ok: false, error: "A pack name must be a string" });
  });

  test("the same faults give the same refusal whatever the listing order", () => {
    const one = Composition.compose([ext, base, other], ["ext", "zed", "other"]);
    const two = Composition.compose([other, base, ext], ["other", "zed", "ext"]);
    expect(one).toEqual(two);
    expect(one).toEqual({ ok: false, error: "Pack 'zed' is selected but not available. Make it available, or remove it from the selection" });
  });

  test("a check that throws refuses the value instead of letting it through", () => {
    const fragile = definePack({
      id: "base",
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
    expect(Composition.compose([fragile], ["base"])).toEqual({
      ok: false,
      error: "Pack 'base' contributes an invalid value to extension point 'base.words': its check failed (boom). Fix the value, or remove the contribution",
    });
  });

  test("an unselected pack's faults are not checked", () => {
    const broken = untypedPack({ id: "broken", dependsOn: [other], contributes: [contribution(words, [""])] });
    expect(composed([base, broken], ["base"]).packs).toEqual(["base"]);
  });
});
