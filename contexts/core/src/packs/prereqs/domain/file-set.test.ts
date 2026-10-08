import { describe, expect, test } from "bun:test";
import { checkFilePattern, fileSetOf } from "./file-set.ts";

const refused = (raw: unknown): string => {
  const checked = checkFilePattern(raw, "unchangedSince");
  return checked.ok ? "accepted" : checked.error;
};

describe("FileSet — which project files a rule's patterns name", () => {
  test("patterns match ignoring case and see dotfiles", () => {
    const set = fileSetOf(["src/**/*.contract.ts", ".agent-state/*/plan.md"]);
    expect(set.matches("src/a/b.contract.ts")).toBe(true);
    expect(set.matches("SRC/A/B.CONTRACT.TS")).toBe(true);
    expect(set.matches(".agent-state/prereqs/plan.md")).toBe(true);
    expect(set.matches("src/.hidden/x.contract.ts")).toBe(true);
    expect(set.matches("src/a/b.ts")).toBe(false);
    expect(set.matches(".agent-state/prereqs/review.md")).toBe(false);
  });

  test("a glob-free pattern covers everything under it", () => {
    const set = fileSetOf(["infra"]);
    expect(set.matches("infra")).toBe(true);
    expect(set.matches("infra/a.tf")).toBe(true);
    expect(set.matches("INFRA/x/y")).toBe(true);
    expect(set.matches("infrastructure/a")).toBe(false);
  });

  test("a directory may hold a match only on a pattern's fixed leading path", () => {
    const set = fileSetOf(["src/**", "docs/spec.md"]);
    expect(set.mayHold("src")).toBe(true);
    expect(set.mayHold("src/a/b")).toBe(true);
    expect(set.mayHold("SRC/a")).toBe(true);
    expect(set.mayHold("docs")).toBe(true);
    expect(set.mayHold("docs/old")).toBe(false);
    expect(set.mayHold("test")).toBe(false);
    expect(fileSetOf(["**/*.tf"]).mayHold("anything/at/all")).toBe(true);
    expect(fileSetOf(["infra"]).mayHold("infra/modules")).toBe(true);
  });

  test("Bounded's state, node_modules and .git never match", () => {
    const set = fileSetOf(["**"]);
    expect(set.matches("src/a.ts")).toBe(true);
    for (const path of [".bounded/prereqs/records.jsonl", ".BOUNDED/x", "node_modules/a/index.js", "packages/x/node_modules/y.js", ".git/HEAD", "sub/.git/config"]) expect(set.matches(path)).toBe(false);
    for (const dir of [".bounded", "node_modules", "packages/x/node_modules", ".git"]) expect(set.mayHold(dir)).toBe(false);
  });

  test("patterns are checked as the path gate checks them", () => {
    expect(refused("/etc/passwd")).toContain("'/etc/passwd' is absolute");
    expect(refused("../outside/**")).toContain("'../outside/**' uses '..'");
    expect(refused("!src/**")).toContain("'!src/**' is negated");
    expect(refused("@(a|b)/x")).toContain("'@(a|b)/x' uses parentheses");
    expect(refused("{a/b,c}")).toContain("'{a/b,c}' has '/' inside a group");
    expect(refused("src/*a*b*c*d*e")).toContain("'src/*a*b*c*d*e' has more than three wildcards");
    expect(refused(".bounded/**")).toContain("'.bounded/**' is inside .bounded, Bounded's own state");
    expect(refused(".Bounded/prereqs/records.jsonl")).toContain("is inside .bounded, Bounded's own state");
    expect(refused("")).toBe("A rule's unchangedSince pattern must not be empty");
    expect(refused(3)).toBe("A rule's unchangedSince pattern must be text");
    expect(checkFilePattern("./spec.md", "unchangedSince")).toEqual({ ok: true, value: "spec.md" });
    expect(checkFilePattern(" src//**/*.ts ", "before.write")).toEqual({ ok: true, value: "src/**/*.ts" });
    const write = checkFilePattern("/abs", "before.write");
    expect(!write.ok && write.error).toStartWith("A rule's before.write pattern '/abs'");
  });
});
