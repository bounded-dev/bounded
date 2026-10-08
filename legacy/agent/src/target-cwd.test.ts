import { describe, expect, test } from "vitest";
import { targetCwd } from "./target-cwd.ts";

// One rule for "which directory does the gate run in", shared by every host
// (ADR 2026-029). Pure, so the whole behaviour is three cases.

describe("targetCwd", () => {
  test("no parameter: the caller's own cwd", () => {
    expect(targetCwd("/work/proj")).toBe("/work/proj");
    expect(targetCwd("/work/proj", "")).toBe("/work/proj");
  });

  test("an absolute parameter wins outright", () => {
    expect(targetCwd("/work/proj", "/elsewhere/x")).toBe("/elsewhere/x");
  });

  test("a relative parameter resolves against the caller's cwd, not the process's", () => {
    expect(targetCwd("/work/proj", "sub/dir")).toBe("/work/proj/sub/dir");
    expect(targetCwd("/work/proj", "../other")).toBe("/work/other");
  });
});
