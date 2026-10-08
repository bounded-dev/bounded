import { describe, expect, test } from "bun:test";
import { Composition } from "../composition/composition.ts";
import type { Result } from "../shared/result.ts";
import type { BasePack } from "./pack.contract.ts";
import { contribution, definePack, parsePack, point, pointGroup } from "./pack.ts";
import { portKeysFor } from "../lifecycle/port-key.ts";
import { packIdsFor } from "./pack-id.ts";

const packId = packIdsFor("test-packs");
const text = (raw: unknown): Result<string> => (typeof raw === "string" ? { ok: true, value: raw } : { ok: false, error: "not text" });

describe("definePack, point and contribution — packs as the core makes them", () => {
  test("definePack makes a frozen pack whose points are owned by it, each with the id <pack>.<key>", () => {
    const words = definePack({ id: packId("words"), points: { words: point({ description: "Words", check: text, values: ["alpha"] }) } });
    expect(words.id.value).toBe("test-packs/words");
    expect(Object.isFrozen(words)).toBe(true);
    expect(Object.isFrozen(words.points)).toBe(true);
    expect(words.points.words.owner).toBe(words);
    expect(words.points.words.id).toBe("test-packs/words.words");
    expect(words.points.words.description).toBe("Words");
  });

  test("a point and a contribution are frozen, their values kept as lists", () => {
    const declared = point({ description: "Words", check: text, values: ["alpha"] });
    expect(Object.isFrozen(declared)).toBe(true);
    expect(declared.values).toEqual(["alpha"]);
    const words = definePack({ id: packId("words"), points: { words: declared } });
    const given = contribution(words.points.words, ["beta"]);
    expect(Object.isFrozen(given)).toBe(true);
    expect(given.values).toEqual(["beta"]);
    expect(given.point).toBe(words.points.words);
  });

  test("only what definePack made is a pack: a copy of one is refused when packs are composed", () => {
    const words = definePack({ id: packId("words"), points: { words: point({ description: "Words", check: text }) } });
    const copy = { ...words };
    const composed = Composition.compose([copy as typeof words], [copy as typeof words]);
    expect(composed.ok).toBe(false);
    expect(!composed.ok && composed.error).toContain("was not built with definePack(...), or was built by a different copy of bounded");
  });

  test("a group's member points have the ids <pack>.<group>.<member>, are owned by the pack and frozen, and are read like any point", () => {
    const words = definePack({
      id: packId("words"),
      points: { byLanguage: pointGroup({ english: point({ description: "English words", check: text, values: ["alpha"] }), french: point({ description: "French words", check: text }) }) },
    });
    const { english, french } = words.points.byLanguage;
    expect(Object.isFrozen(words.points.byLanguage)).toBe(true);
    expect(Object.keys(words.points.byLanguage)).toEqual(["english", "french"]);
    expect([english.id, french.id]).toEqual(["test-packs/words.byLanguage.english", "test-packs/words.byLanguage.french"]);
    expect(english.owner).toBe(words);
    expect(Object.isFrozen(english)).toBe(true);
    const user = definePack({ id: packId("user"), dependsOn: [words], contributes: [contribution(french, ["bonjour"])] });
    const composed = Composition.compose([words, user], [words, user]);
    expect(composed.ok && composed.value.read(english)).toEqual({ ok: true, value: ["alpha"] });
    expect(composed.ok && composed.value.read(french)).toEqual({ ok: true, value: ["bonjour"] });
  });
});

describe("Pack — its shape, checked when it is made", () => {
  /** A pack built from untyped data at run time, where the compiler checks nothing. */
  const untypedPack = (spec: object): BasePack => (definePack as unknown as (spec: object) => BasePack)(spec);
  const COPY = "by this copy of bounded";
  const anything = (raw: unknown): Result<unknown> => ({ ok: true, value: raw });
  const base = definePack({ id: packId("base"), points: { words: point({ description: "Words", check: text }) } });

  test("a pack made from typed parts has no problem", () => {
    expect(base.problem).toBeUndefined();
    expect(definePack({ id: packId("user"), dependsOn: [base], contributes: [contribution(base.points.words, ["x"])] }).problem).toBeUndefined();
  });

  const problems: [string, object, string][] = [
    ["dependencies that are not a list", { dependsOn: 5 }, `its dependsOn must be a list of packs made with definePack(...) ${COPY}`],
    ["dependencies given by id, not as packs", { dependsOn: ["test-packs/base"] }, `its dependsOn must be a list of packs made with definePack(...) ${COPY}`],
    ["a dependency listed twice", { dependsOn: [base, base] }, "it lists 'test-packs/base' twice in dependsOn"],
    ["a point key that is not camelCase", { points: { "a.b": point({ description: "Dotted", check: anything }) } }, "its point key 'a.b' must be a camelCase word, such as 'protectedPaths'"],
    ["a point declared on another pack's behalf", { points: { stolen: base.points.words } }, `its points must each be declared with point(...) ${COPY}`],
    ["a point declared without a check", { points: { loose: point({ description: "No check" } as never) } }, "its point 'loose' has no check: every point parses the values it accepts"],
    ["a point whose own values are not a list", { points: { odd: point({ description: "Odd", check: anything, values: 5 } as never) } }, "the own values of its point 'odd' must be a list"],
    ["a contribution that is not a genuine contribution", { dependsOn: [base], contributes: [{ __brand: "Contribution", point: base.points.words, values: [] }] }, `its contributes must be a list of contributions made with contribution(...) ${COPY}`],
    ["a group inside a group", { points: { outer: pointGroup({ inner: pointGroup({ deep: point({ description: "Deep", check: anything }) }) } as never) } }, "its point 'outer.inner' is a group inside a group: groups of points are one level deep"],
  ];
  for (const [title, spec, problem] of problems) {
    test(`names its problem: ${title}`, () => {
      expect(untypedPack({ id: "test-packs/bad", ...spec }).problem).toBe(problem);
    });
  }

  test("parsePack takes a pack definePack made, and refuses a copy or anything else, naming it", () => {
    expect(parsePack(base)).toEqual({ ok: true, value: base });
    const refusal = (id: string) => ({ ok: false as const, error: `'${id}' was not built with definePack(...), or was built by a different copy of bounded. Build every pack with definePack from one copy` });
    expect(parsePack({ ...base })).toEqual(refusal("test-packs/base"));
    expect(parsePack(null)).toEqual(refusal("null"));
  });

  test("points, declarations and contributions are instances of their classes, not plain objects", () => {
    const declared = point({ description: "Words", check: text });
    expect(Object.getPrototypeOf(declared)).not.toBe(Object.prototype);
    expect(Object.getPrototypeOf(base.points.words)).not.toBe(Object.prototype);
    expect(Object.getPrototypeOf(contribution(base.points.words, ["x"]))).not.toBe(Object.prototype);
    expect(Object.getPrototypeOf(base)).not.toBe(Object.prototype);
  });

  test("a point parses a value with its own check: a check that throws or returns no result refuses, never throws", () => {
    const odd = definePack({
      id: packId("odd"),
      points: {
        throws: point({ description: "Throws", check: (): Result<string> => { throw new Error("boom"); } }),
        empty: point({ description: "Empty", check: () => ({ ok: true }) as unknown as Result<string> }),
      },
    });
    expect(base.points.words.parseValue("x")).toEqual({ ok: true, value: "x" });
    expect(base.points.words.parseValue(5)).toEqual({ ok: false, error: "not text" });
    expect(odd.points.throws.parseValue("x")).toEqual({ ok: false, error: "its check failed (boom)" });
    expect(odd.points.empty.parseValue("x")).toEqual({ ok: false, error: "its check returned no result" });
  });
});

describe("Pack — the ports it needs a host to provide", () => {
  const untypedPack = (spec: object): BasePack => (definePack as unknown as (spec: object) => BasePack)(spec);
  const gateId = packId("gate");
  const files = portKeysFor(gateId)<{ read(): string }>("files");

  test("its ports section is stored on the pack, frozen; a pack without one has none", () => {
    const gate = definePack({ id: gateId, ports: { files } });
    expect(gate.ports.files).toBe(files);
    expect(Object.isFrozen(gate.ports)).toBe(true);
    expect(gate.problem).toBeUndefined();
    expect(definePack({ id: packId("plain") }).ports).toEqual({});
  });

  test("names its problem: a port that is not a port key, one another pack owns, or a key that is not camelCase", () => {
    expect(untypedPack({ id: "test-packs/gate", ports: { files: { owner: gateId, name: "files" } } }).problem).toBe("its port 'files' must be declared with portKeysFor(...) by this copy of bounded");
    expect(untypedPack({ id: "test-packs/other", ports: { files } }).problem).toBe("its port 'files' belongs to test-packs/gate: a pack declares only its own ports");
    expect(untypedPack({ id: "test-packs/gate", ports: { "a.b": files } }).problem).toBe("its port key 'a.b' must be a camelCase word, such as 'watchedFiles'");
  });
});
