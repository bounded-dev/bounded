import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import {
  type CommandRunner,
  formatTypecheck,
  generatedLayoutProblem,
  parseTscOutput,
  redactAbsolutePaths,
  typecheck,
  TYPECHECK_COMMAND,
} from "./typecheck.ts";

function fakeRunner(stdout: string, stderr = "", code: number | null = 0): CommandRunner {
  return async () => ({ stdout, stderr, code });
}

describe("redactAbsolutePaths", () => {
  test("relativizes paths under the project cwd", () => {
    const out = redactAbsolutePaths("/proj/src/a.ts(1,2): error TS2322: bad", "/proj");
    expect(out).toBe("src/a.ts(1,2): error TS2322: bad");
  });

  test("redacts absolute paths outside the cwd to [path]", () => {
    const out = redactAbsolutePaths("/Users/secret/node_modules/x/y.d.ts(3,4): error TS1: no", "/proj");
    expect(out).not.toContain("/Users/secret");
    expect(out).toContain("[path]");
  });

  test("leaves already-relative paths alone", () => {
    expect(redactAbsolutePaths("src/a.ts(1,2): error TS2322: bad", "/proj")).toBe(
      "src/a.ts(1,2): error TS2322: bad",
    );
  });
});

describe("parseTscOutput", () => {
  test("clean pass yields ok with zero errors", () => {
    const r = parseTscOutput("", "", 0, "/proj");
    expect(r.ok).toBe(true);
    expect(r.errorCount).toBe(0);
    expect(r.diagnostics).toEqual([]);
  });

  test("counts errors and redacts absolute paths in diagnostics", () => {
    const stdout = [
      "/proj/src/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.",
      "/proj/src/b.ts(9,1): error TS2304: Cannot find name 'foo'.",
    ].join("\n");
    const r = parseTscOutput(stdout, "", 2, "/proj");
    expect(r.ok).toBe(false);
    expect(r.errorCount).toBe(2);
    expect(r.diagnostics).toHaveLength(2);
    expect(r.diagnostics[0]).toBe(
      "src/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
    expect(r.diagnostics.join("\n")).not.toContain("/proj");
  });
});

describe("typecheck", () => {
  test("passing project", async () => {
    const r = await typecheck("/proj", { run: fakeRunner("", "", 0) });
    expect(r.ok).toBe(true);
    expect(r.errorCount).toBe(0);
  });

  test("failing project surfaces redacted diagnostics", async () => {
    const stdout = "/proj/src/a.ts(1,2): error TS2322: bad";
    const r = await typecheck("/proj", { run: fakeRunner(stdout, "", 2) });
    expect(r.ok).toBe(false);
    expect(r.errorCount).toBe(1);
    expect(r.diagnostics[0]).toBe("src/a.ts(1,2): error TS2322: bad");
  });
});

describe("formatTypecheck", () => {
  test("pass message", () => {
    expect(formatTypecheck({ ok: true, errorCount: 0, diagnostics: [] })).toMatch(/pass|no errors|ok/i);
  });

  test("failure lists diagnostics", () => {
    const text = formatTypecheck({
      ok: false,
      errorCount: 1,
      diagnostics: ["src/a.ts(1,2): error TS2322: bad"],
    });
    expect(text).toContain("src/a.ts(1,2): error TS2322: bad");
    expect(text).toMatch(/1 error/i);
  });
});

describe("the type-check invocation (ADR LEG-2026-062)", () => {
  test("bunx tsc on the generated tsconfig.json, one-line diagnostics", async () => {
    const seen: string[][] = [];
    await typecheck("/proj", { run: async (command, args) => { seen.push([command, ...args]); return { stdout: "", stderr: "", code: 0 }; } });
    expect(seen).toEqual([["bunx", "tsc", "-p", "tsconfig.json", "--pretty", "false"]]);
    expect(TYPECHECK_COMMAND).toEqual({ command: "bunx", args: ["tsc", "-p", "tsconfig.json", "--pretty", "false"] });
  });
});

describe("a generated project with no source roots", () => {
  test("is refused with the fix, not handed to tsc with an empty include", async () => {
    const dir = mkdtempSync(join(tmpdir(), "typecheck-noroots-"));
    try {
      writeProjectPacks(dir, ["ts"]);
      writeFileSync(join(dir, ".bounded", "installation.json"), "{}\n");
      expect(generatedLayoutProblem(dir)).toMatch(/no composed pack contributes sourceRoots.*compose the layout pack/);
      // A project whose config the packs did not generate keeps its own tsconfig.
      rmSync(join(dir, ".bounded", "installation.json"));
      expect(generatedLayoutProblem(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const HAS_BUN = spawnSync("bun", ["--version"]).status === 0;
if (!HAS_BUN) console.warn("typecheck.test.ts: skipping the real bunx tsc test — `bun` is not on PATH");

describe.skipIf(!HAS_BUN)("real bunx tsc", () => {
  test("reports a monorepo type error by its project-relative path", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "typecheck-bunx-"));
    try {
      mkdirSync(join(dir, "contexts", "pm", "src"), { recursive: true });
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["contexts/*/src"] }));
      writeFileSync(join(dir, "contexts", "pm", "src", "note.test.ts"), "export const n: number = 'x';\n");
      symlinkSync(join(import.meta.dirname, "..", "..", "..", "node_modules"), join(dir, "node_modules"), "dir");
      const r = await typecheck(dir);
      expect(r.ok).toBe(false);
      expect(r.diagnostics[0]).toMatch(/^contexts\/pm\/src\/note\.test\.ts\(1,14\): error TS2322/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
