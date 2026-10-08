import { describe, expect, test } from "vitest";
import {
  composePacks,
  contribute,
  definePack,
  socketsOwnedBy,
  SocketRegistryError,
  type PackDefinition,
} from "./socket-registry.ts";

// TN-26-005: the core owns mechanisms, packs own content, and no pack depends
// on another implicitly. The compile-time half of that rule cannot be asserted
// from inside a test — a compile error is not a value — so the suite covers the
// RUNTIME half exhaustively and the type-level half is pinned by the
// deliberately-typed fixtures below: if the owner phantom stopped working,
// `wrongEdge` would compile clean and `npm run check` would go green on a
// broken registry. It is kept honest by a `@ts-expect-error`-free style: the
// fixture that must not typecheck is built through the erased `PackDefinition`
// door on purpose, and the comment says why.

// --- fixtures ---------------------------------------------------------------

const hostSockets = socketsOwnedBy("host");

interface Widget {
  readonly name: string;
  readonly weight: number;
}

const widgets = hostSockets.define<Widget>({
  id: "widgets",
  description: "widgets the host hangs in its toolbar",
});

const labels = hostSockets.define<string>({
  id: "labels",
  description: "free-text labels",
  validate: (value, contributor) =>
    value.trim() === "" ? `empty label from '${contributor}'` : undefined,
});

const host = definePack({
  name: "host",
  dependsOnPacks: [],
  defines: [widgets, labels],
  contributes: [contribute(labels, ["host-own"])],
});

describe("a socket carries its owner and its description", () => {
  test("the factory stamps the owner onto every socket it defines", () => {
    expect(widgets.owner).toBe("host");
    expect(labels.owner).toBe("host");
  });

  test("a socket is frozen — its identity is not something a consumer edits", () => {
    expect(Object.isFrozen(widgets)).toBe(true);
  });
});

describe("composition places contributions on their sockets", () => {
  const guest = definePack({
    name: "guest",
    dependsOnPacks: ["host"],
    contributes: [contribute(widgets, [{ name: "clock", weight: 2 }])],
  });

  test("a read returns the contributed values", () => {
    const registry = composePacks([host, guest]);
    expect(registry.read(widgets)).toEqual([{ name: "clock", weight: 2 }]);
  });

  test("a socket nobody contributed to reads empty, never undefined", () => {
    const registry = composePacks([host]);
    expect(registry.read(widgets)).toEqual([]);
  });

  // A gate that read its rule list and then appended to it would be editing
  // every other consumer's list too. Frozen, and a fresh array per read, so
  // neither route exists.
  test("reads are frozen — a consumer cannot edit the composition it was handed", () => {
    expect(Object.isFrozen(composePacks([host, guest]).read(widgets))).toBe(true);
  });

  test("two reads of the same socket do not share an array", () => {
    const registry = composePacks([host, guest]);
    expect(registry.read(widgets)).not.toBe(registry.read(widgets));
  });

  test("a pack may contribute to its own socket", () => {
    expect(composePacks([host]).read(labels)).toEqual(["host-own"]);
  });

  test("the sockets a composition defines are reported, sorted", () => {
    const registry = composePacks([host, guest]);
    expect(registry.sockets.map((s) => s.id)).toEqual(["labels", "widgets"]);
    expect(registry.hasSocket("widgets")).toBe(true);
    expect(registry.hasSocket("nothing-defines-this")).toBe(false);
  });
});

describe("the pack list decides what is composed", () => {
  const guest = definePack({
    name: "guest",
    dependsOnPacks: ["host"],
    contributes: [contribute(widgets, [{ name: "clock", weight: 2 }])],
  });

  test("no list composes every installed pack (what v1 callers pass)", () => {
    expect(composePacks([host, guest]).read(widgets)).toHaveLength(1);
  });

  // The whole reason composition takes a filter: at project initiation most
  // installed packs stay uncomposed, and an uncomposed pack must contribute
  // NOTHING — not a filtered value, not an empty placeholder.
  test("a pack left out of the list contributes nothing", () => {
    const registry = composePacks([host, guest], ["host"]);
    expect(registry.read(widgets)).toEqual([]);
    expect(registry.packs).toEqual(["host"]);
  });

  test("composing a pack that is not installed is refused by name", () => {
    expect(() => composePacks([host], ["host", "ghost"])).toThrow(/pack 'ghost' is composed but not installed/);
  });

  test("a dependency left out of the composition is refused, not silently dropped", () => {
    expect(() => composePacks([host, guest], ["guest"])).toThrow(
      /pack 'guest' depends on pack 'host', which is installed but not composed/,
    );
  });

  test("a dependency that was never installed says so differently", () => {
    const orphan = definePack({ name: "orphan", dependsOnPacks: ["absent"] });
    expect(() => composePacks([orphan])).toThrow(/depends on pack 'absent', which is not installed/);
  });
});

describe("no pack depends on another implicitly", () => {
  // The runtime half of the phantom owner type. Reaching this state through the
  // typed door is a compile error, so the fixture is assembled through the
  // ERASED PackDefinition shape — which is exactly how a pack built
  // dynamically, or one compiled against a stale version of its dependency,
  // would arrive here.
  const wrongEdge: PackDefinition = {
    name: "stranger",
    dependsOnPacks: [],
    defines: [],
    contributes: [contribute(widgets, [{ name: "uninvited", weight: 1 }])],
  };

  test("a contribution with no declared edge is refused, naming the missing edge", () => {
    expect(() => composePacks([host, wrongEdge])).toThrow(SocketRegistryError);
    expect(() => composePacks([host, wrongEdge])).toThrow(
      /pack 'stranger' contributes to socket 'widgets', owned by pack 'host' — but 'stranger' does not declare 'host' in dependsOnPacks/,
    );
  });

  test("the refusal names the remedy, not just the fault", () => {
    expect(() => composePacks([host, wrongEdge])).toThrow(/Add the dependency edge/);
  });

  test("a contribution to a socket no composed pack defines is refused", () => {
    const stray = socketsOwnedBy("host").define<string>({ id: "not-defined", description: "x" });
    const guest = definePack({
      name: "guest",
      dependsOnPacks: ["host"],
      contributes: [contribute(stray, ["x"])],
    });
    expect(() => composePacks([host, guest])).toThrow(
      /contributes to socket 'not-defined', which pack 'host' does not define/,
    );
  });
});

describe("sockets belong to exactly one pack", () => {
  test("a pack may not define another pack's socket", () => {
    const thief: PackDefinition = {
      name: "thief",
      dependsOnPacks: ["host"],
      defines: [widgets],
      contributes: [],
    };
    expect(() => composePacks([host, thief])).toThrow(
      /pack 'thief' defines socket 'widgets', which declares pack 'host' as its owner/,
    );
  });

  test("two packs defining the same socket id are refused", () => {
    const rival = definePack({
      name: "rival",
      dependsOnPacks: [],
      defines: [socketsOwnedBy("rival").define<string>({ id: "widgets", description: "clash" })],
    });
    expect(() => composePacks([host, rival])).toThrow(/socket id 'widgets' is defined twice/);
  });

  test("two installed packs with the same name are refused", () => {
    expect(() => composePacks([host, host])).toThrow(/two installed packs are both named 'host'/);
  });
});

describe("the validation hook runs at the seam", () => {
  test("a value the socket refuses blocks composition with the hook's own words", () => {
    const guest = definePack({
      name: "guest",
      dependsOnPacks: ["host"],
      contributes: [contribute(labels, ["fine", "  "])],
    });
    expect(() => composePacks([host, guest])).toThrow(
      /pack 'guest' contributes an invalid value to socket 'labels': empty label from 'guest'/,
    );
  });

  test("a socket without a hook accepts anything of its type", () => {
    const guest = definePack({
      name: "guest",
      dependsOnPacks: ["host"],
      contributes: [contribute(widgets, [{ name: "", weight: -1 }])],
    });
    expect(composePacks([host, guest]).read(widgets)).toHaveLength(1);
  });
});

describe("registration is dependency-ordered", () => {
  // base ← middle ← leaf, listed in the most unhelpful order possible, so the
  // outcome can only come from the declared edges.
  const baseSockets = socketsOwnedBy("base");
  const steps = baseSockets.define<string>({ id: "steps", description: "ordered steps" });
  const base = definePack({
    name: "base",
    dependsOnPacks: [],
    defines: [steps],
    contributes: [contribute(steps, ["base"])],
  });
  const middle = definePack({
    name: "middle",
    dependsOnPacks: ["base"],
    contributes: [contribute(steps, ["middle"])],
  });
  // `base` is named here as well as `middle`, and it HAS to be: a dependency
  // edge is not transitive. leaf fills a socket base owns, so leaf declares
  // base — "nothing depends on ts-api by accident" cuts both ways, and an edge
  // inherited through a third pack is exactly the implicit dependency the note
  // forbids. Dropping "base" below makes the fixture a compile error.
  const leaf = definePack({
    name: "leaf",
    dependsOnPacks: ["middle", "base"],
    contributes: [contribute(steps, ["leaf"])],
  });

  test("dependencies are composed before their dependents", () => {
    expect(composePacks([leaf, middle, base]).packs).toEqual(["base", "middle", "leaf"]);
  });

  test("contributions arrive in that same order", () => {
    expect(composePacks([leaf, middle, base]).read(steps)).toEqual(["base", "middle", "leaf"]);
  });

  test("the order does not depend on how the installed list was assembled", () => {
    const one = composePacks([leaf, middle, base]).read(steps);
    const two = composePacks([base, leaf, middle]).read(steps);
    expect(one).toEqual(two);
  });

  // The runtime says the same thing the compiler said: an edge reached through
  // a third pack is not an edge.
  test("a dependency edge is not transitive", () => {
    const sneaky: PackDefinition = {
      name: "sneaky",
      dependsOnPacks: ["middle"],
      defines: [],
      contributes: [contribute(steps, ["sneaky"])],
    };
    expect(() => composePacks([base, middle, sneaky])).toThrow(
      /pack 'sneaky' contributes to socket 'steps', owned by pack 'base' — but 'sneaky' does not declare 'base'/,
    );
  });

  test("a cycle is refused and the message prints the loop", () => {
    const a: PackDefinition = { name: "a", dependsOnPacks: ["b"], defines: [], contributes: [] };
    const b: PackDefinition = { name: "b", dependsOnPacks: ["a"], defines: [], contributes: [] };
    expect(() => composePacks([a, b])).toThrow(/pack dependency cycle: a → b → a/);
  });

  test("a pack depending on itself is the one-node cycle", () => {
    const self: PackDefinition = { name: "self", dependsOnPacks: ["self"], defines: [], contributes: [] };
    expect(() => composePacks([self])).toThrow(/pack dependency cycle: self → self/);
  });

  test("a diamond composes once, not twice", () => {
    const left = definePack({ name: "left", dependsOnPacks: ["base"], contributes: [contribute(steps, ["left"])] });
    const right = definePack({ name: "right", dependsOnPacks: ["base"], contributes: [contribute(steps, ["right"])] });
    const top = definePack({ name: "top", dependsOnPacks: ["left", "right"] });
    const registry = composePacks([top, right, left, base]);
    expect(registry.packs.filter((p) => p === "base")).toEqual(["base"]);
    expect(registry.read(steps)).toEqual(["base", "left", "right"]);
  });
});

describe("definePack normalises what it is given", () => {
  test("omitted defines and contributes are empty, not undefined", () => {
    const bare = definePack({ name: "bare", dependsOnPacks: [] });
    expect(bare.defines).toEqual([]);
    expect(bare.contributes).toEqual([]);
  });

  test("a definition is frozen — composition cannot be steered by editing a pack", () => {
    expect(Object.isFrozen(host)).toBe(true);
    expect(Object.isFrozen(host.dependsOnPacks)).toBe(true);
  });
});
