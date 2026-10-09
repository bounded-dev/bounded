import { describe, expect, test } from "bun:test";
import { WatchedPath } from "./watched-path.ts";
import { isInside, isOwnState, mayHold, ruleFields, watcher } from "./watching.ts";

const rule = (raw: object): WatchedPath => {
  const parsed = WatchedPath.parse({ why: "w", redirect: "r", ...raw });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const rules = [rule({ match: "generated/**", except: ["generated/keep/**"] }), rule({ match: "**/*.lock" })];

describe("watching — how watched paths meet files", () => {
  test("a path is watched by every rule that matches it, its match ignoring case, its except exact", () => {
    const watches = watcher(rules);
    expect(watches("generated/a.ts")).toEqual([0]);
    expect(watches("GENERATED/a.ts")).toEqual([0]);
    expect(watches("generated/keep/a.ts")).toEqual([]);
    expect(watches("generated/x.lock")).toEqual([0, 1]);
  });

  test("bounded's own state, version control and dependencies are never watched", () => {
    expect([".bounded/log.jsonl", ".bounded/guard-log.jsonl", "a/.git/x", "node_modules/p/x.lock"].map(isOwnState)).toEqual([true, true, true, true]);
    expect(watcher(rules)("node_modules/p/x.lock")).toEqual([]);
  });

  test("a path holding a control character is watched by every rule whose leading folder holds it", () => {
    expect(watcher(rules)("generated/a\nb.ts")).toEqual([0, 1]);
  });

  test("a walk enters only directories that may hold a watched file", () => {
    const may = mayHold([rule({ match: "generated/**" })]);
    expect([may("generated"), may("generated/sub"), may("src"), may("node_modules")]).toEqual([true, true, false, false]);
  });

  test("a file's rule fields name its first rule, and all of them when there are several", () => {
    expect(ruleFields([1])).toEqual({ rule: 1 });
    expect(ruleFields([0, 1])).toEqual({ rule: 0, rules: [0, 1] });
  });

  test("a project path is relative, without '..' or empty parts", () => {
    expect(["a/b", "/a", "a/../b", "a//b", "./a", ""].map(isInside)).toEqual([true, false, false, false, false, false]);
  });
});
