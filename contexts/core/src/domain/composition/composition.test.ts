import { describe, expect, test } from "bun:test";
import { ExtensionPoint } from "../extension-points/extension-point.ts";
import { Contribution } from "../packs/contribution.ts";
import { Pack } from "../packs/pack.ts";
import { PackName } from "../packs/pack-name.ts";
import type { Composition as CompositionContract } from "./composition.contract.ts";
import { Composition } from "./composition.ts";

// "base" declares an extension point for words; "ext" depends on base and
// contributes more words; "other" is unrelated.
const words = ExtensionPoint.ownedBy("base").declare<string>({
  id: "base.words",
  description: "Words any dependent pack may add",
  check: (word) => (word.length > 0 ? undefined : "a word is not empty"),
});
const basePack = new Pack({ name: "base", declares: [words], contributes: [new Contribution(words, ["alpha"])] });
const extPack = new Pack({ name: "ext", dependsOn: ["base"], contributes: [new Contribution(words, ["beta", "gamma"])] });
const otherPack = new Pack({ name: "other" });

function compose(available: readonly Pack[], selected: readonly string[]) {
  const names = selected.map((raw) => {
    const name = PackName.parse(raw);
    if (!name.ok) throw new Error(name.error);
    return name.value;
  });
  return Composition.compose(available, names);
}

function composed(available: readonly Pack[], selected: readonly string[]): CompositionContract {
  const result = compose(available, selected);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** A pack built from data at run time, where the compiler cannot check its edges. */
function untypedPack(spec: object): Pack {
  return new (Pack as unknown as new (spec: object) => Pack)(spec);
}

describe("Composition — reading an extension point", () => {
  test("returns every contributed value, typed, dependencies' before dependents'", () => {
    const composition = composed([extPack, basePack], ["ext", "base"]);
    expect(composition.packs).toEqual(["base", "ext"]);
    expect(composition.read(words)).toEqual({ ok: true, value: ["alpha", "beta", "gamma"] });
  });

  test("never depends on the order packs were listed in", () => {
    const b = new Pack({ name: "b", dependsOn: ["base"], contributes: [new Contribution(words, ["b"])] });
    const a = new Pack({ name: "a", dependsOn: ["base", "b"], contributes: [new Contribution(words, ["a"])] });
    const c = new Pack({ name: "c", dependsOn: ["base"], contributes: [new Contribution(words, ["c"])] });
    const one = composed([a, b, c, basePack], ["a", "b", "c", "base"]);
    const two = composed([basePack, c, b, a], ["base", "c", "b", "a"]);
    expect(one.packs).toEqual(["base", "b", "a", "c"]);
    expect(two.packs).toEqual(one.packs);
    expect(two.read(words)).toEqual({ ok: true, value: ["alpha", "b", "a", "c"] });
  });

  test("a pack that is not selected leaves no trace", () => {
    expect(composed([basePack, extPack], ["base"]).read(words)).toEqual({ ok: true, value: ["alpha"] });
    expect(composed([basePack, otherPack], ["other"]).read(words)).toEqual({
      ok: false,
      error: "Extension point 'base.words' does not exist in this composition: its owner 'base' is not selected. Select 'base' to use it",
    });
  });

  test("a point its selected owner does not declare is told apart from an unselected owner's", () => {
    const unlisted = ExtensionPoint.ownedBy("base").declare<string>({ id: "base.unlisted", description: "Never declared" });
    expect(composed([basePack], ["base"]).read(unlisted)).toEqual({
      ok: false,
      error: "Extension point 'base.unlisted' does not exist in this composition: its owner 'base' is selected but does not declare it. Declare it in 'base', or read a point 'base' declares",
    });
  });

  test("reading with a look-alike point object (same id, other value type) is refused", () => {
    const lookAlike = ExtensionPoint.ownedBy("base").declare<number>({ id: "base.words", description: "Not the real one" });
    expect(composed([basePack], ["base"]).read(lookAlike)).toEqual({
      ok: false,
      error: "Extension point 'base.words' in this composition is a different object from the one read: use the extension point that pack 'base' exports",
    });
  });
});

describe("Composition — every refusal names the pack, the extension point and the fix", () => {
  const refusals: [string, readonly Pack[], readonly string[], string][] = [
    ["a selected pack that is not available", [basePack], ["base", "nope"],
      "Pack 'nope' is selected but not available. Make it available, or remove it from the selection"],
    ["a pack selected twice", [basePack], ["base", "base"],
      "Pack 'base' is selected twice. Select each pack once"],
    ["a selected pack whose dependency is not selected", [basePack, extPack], ["ext"],
      "Pack 'ext' depends on pack 'base', which is not selected. Select 'base' as well, or remove the dependency"],
    ["two packs with the same name", [basePack, new Pack({ name: "base" })], ["base"],
      "Two available packs are named 'base'. Pack names identify packs: rename one of them"],
    ["a dependency cycle, shown in the message",
      [new Pack({ name: "a", dependsOn: ["b"] }), new Pack({ name: "b", dependsOn: ["c"] }), new Pack({ name: "c", dependsOn: ["a"] })], ["c", "b", "a"],
      "Packs depend on each other in a cycle: a -> b -> c -> a. Break the cycle by moving what they share into a pack they all depend on"],
    ["an extension point declared twice",
      [basePack, new Pack({ name: "other", declares: [ExtensionPoint.ownedBy("other").declare<string>({ id: "base.words", description: "Clash" })] })], ["base", "other"],
      "Extension point 'base.words' is declared twice, by packs 'base' and 'other'. Give one of them a different id"],
    ["a pack declaring a point another pack owns", [untypedPack({ name: "thief", declares: [words] })], ["thief"],
      "Pack 'thief' declares extension point 'base.words', which is owned by pack 'base'. A pack declares only its own extension points: declare it in 'base'"],
    ["an extension point id that is not valid",
      [new Pack({ name: "base", declares: [ExtensionPoint.ownedBy("base").declare<string>({ id: "Base Words", description: "Bad id" })] })], ["base"],
      "Pack 'base' declares extension point 'Base Words': Extension point id 'Base Words' must be lowercase words joined by hyphens, in dot-separated segments, such as 'path-gate.protected-paths'. Rename it"],
    ["a contribution across an undeclared dependency that reaches composition anyway",
      [basePack, untypedPack({ name: "rogue", contributes: [new Contribution(words, ["x"])] })], ["base", "rogue"],
      "Pack 'rogue' contributes to extension point 'base.words', owned by pack 'base', but does not depend on 'base'. Add 'base' to the dependencies of 'rogue', or remove the contribution"],
    ["a contribution to a point its owner does not declare",
      [basePack, new Pack({ name: "ext", dependsOn: ["base"], contributes: [new Contribution(ExtensionPoint.ownedBy("base").declare<string>({ id: "base.missing", description: "Never declared" }), ["x"])] })], ["base", "ext"],
      "Pack 'ext' contributes to extension point 'base.missing', which its owner 'base' does not declare. Declare 'base.missing' in 'base', or contribute to a point 'base' declares"],
    ["a contribution through a transitive dependency only",
      [basePack, extPack, untypedPack({ name: "top", dependsOn: ["ext"], contributes: [new Contribution(words, ["x"])] })], ["base", "ext", "top"],
      "Pack 'top' contributes to extension point 'base.words', owned by pack 'base', but does not depend on 'base'. Add 'base' to the dependencies of 'top', or remove the contribution"],
    ["a contribution that is not a genuine Contribution, whatever it claims",
      [basePack, untypedPack({ name: "fake", dependsOn: ["base"], contributes: [{ point: words, values: [42, ""], problems: () => [] }] })], ["base", "fake"],
      "Pack 'fake' is malformed: its contributes must be a list of contributions made with new Contribution(...). Fix its definition"],
    ["a declaration that is not an extension point", [untypedPack({ name: "bad", declares: [null] })], ["bad"],
      "Pack 'bad' is malformed: its declares must be a list of extension points made with ExtensionPoint.ownedBy(...).declare(...). Fix its definition"],
    ["dependencies that are not a list", [untypedPack({ name: "bad", dependsOn: 5 })], ["bad"],
      "Pack 'bad' is malformed: its dependsOn must be a list of pack names. Fix its definition"],
    ["dependencies given as one string, not a list", [basePack, untypedPack({ name: "bad", dependsOn: "base" })], ["base", "bad"],
      "Pack 'bad' is malformed: its dependsOn must be a list of pack names. Fix its definition"],
    ["an available pack not built with new Pack", [basePack, { name: "plain", dependsOn: [], declares: [], contributes: [] } as unknown as Pack], ["base"],
      "Available pack 'plain' was not built with new Pack(...). Build every pack with new Pack({ name, ... })"],
    ["duplicate names, reported by name order whatever the listing order",
      [new Pack({ name: "b" }), new Pack({ name: "b" }), new Pack({ name: "a" }), new Pack({ name: "a" })], ["a"],
      "Two available packs are named 'a'. Pack names identify packs: rename one of them"],
    ["an invalid contributed value",
      [basePack, new Pack({ name: "ext", dependsOn: ["base"], contributes: [new Contribution(words, ["ok", ""])] })], ["base", "ext"],
      "Pack 'ext' contributes an invalid value to extension point 'base.words': a word is not empty. Fix the value, or remove the contribution"],
  ];

  for (const [title, available, selected, message] of refusals) {
    test(title, () => {
      expect(compose(available, selected)).toEqual({ ok: false, error: message });
    });
  }

  test("the same faults give the same refusal whatever the listing order", () => {
    const one = compose([extPack, basePack, otherPack], ["ext", "zed", "other"]);
    const two = compose([otherPack, basePack, extPack], ["other", "zed", "ext"]);
    expect(one).toEqual(two);
    expect(one).toEqual({ ok: false, error: "Pack 'zed' is selected but not available. Make it available, or remove it from the selection" });
  });

  test("a check that throws refuses the value instead of letting it through", () => {
    const fragile = ExtensionPoint.ownedBy("base").declare<string>({
      id: "base.fragile",
      description: "Its check throws",
      check: () => {
        throw new Error("boom");
      },
    });
    const pack = new Pack({ name: "base", declares: [fragile], contributes: [new Contribution(fragile, ["x"])] });
    expect(compose([pack], ["base"])).toEqual({
      ok: false,
      error: "Pack 'base' contributes an invalid value to extension point 'base.fragile': its check failed (boom). Fix the value, or remove the contribution",
    });
  });

  test("an unselected pack's faults are not checked", () => {
    const broken = untypedPack({ name: "broken", dependsOn: ["missing"], contributes: [new Contribution(words, [""])] });
    expect(composed([basePack, broken], ["base"]).packs).toEqual(["base"]);
  });
});
