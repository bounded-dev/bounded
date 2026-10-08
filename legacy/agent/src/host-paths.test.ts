import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { claudeCodePathArgument, hostPathArgument, piPathArgument, piReadVariant } from "./host-paths.ts";

// The gate must judge the path a host will really open (ADR 2026-057). These
// pin the mirror of pi's path rewriting against pi's own source, so a pi
// upgrade that changes it fails here before it can open a gap.

const PI = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@earendil-works", "pi-coding-agent");
const HOME = "/home/someone";

describe("pi's own source, as installed", () => {
  const paths = readFileSync(join(PI, "dist/utils/paths.js"), "utf8");
  const pathUtils = readFileSync(join(PI, "dist/core/tools/path-utils.js"), "utf8");

  test("normalizePath still does exactly the steps piPathArgument mirrors", () => {
    expect(paths).toContain("const UNICODE_SPACES = /[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g;");
    expect(paths).toContain('if (options.stripAtPrefix && normalized.startsWith("@")) {\n        normalized = normalized.slice(1);');
    expect(paths).toContain('if (normalized === "~")\n            return home;');
    expect(paths).toContain('if (normalized.startsWith("~/")');
    expect(paths).toContain("if (/^file:\\/\\//.test(normalized)) {\n        return fileURLToPath(normalized);");
  });

  test("every path tool resolves through resolveToCwd with unicode spaces and '@' on", () => {
    expect(pathUtils).toContain("return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });");
    for (const tool of ["read", "write", "edit", "ls", "find", "grep"]) {
      expect(readFileSync(join(PI, `dist/core/tools/${tool}.js`), "utf8"), tool).toMatch(/resolve(?:ToCwd|ReadPathAsync)\(/);
    }
  });

  test("the read tool's fallback spellings are the four piReadVariant tries", () => {
    expect(pathUtils).toContain("filePath.replace(/ (AM|PM)\\./gi, `${NARROW_NO_BREAK_SPACE}$1.`)");
    expect(pathUtils).toContain('filePath.normalize("NFD")');
    expect(pathUtils).toContain('filePath.replace(/\'/g, "\\u2019")');
  });

  test("grep hands its glob to rg as one --glob value: pi splits nothing", () => {
    const grep = readFileSync(join(PI, "dist/core/tools/grep.js"), "utf8");
    expect(grep).toContain('args.push("--glob", glob);');
    expect(grep).not.toMatch(/glob\.split\(/);
  });
});

describe("piPathArgument mirrors normalizePath step for step", () => {
  test.each([
    ["contexts/a/src/x.ts", "contexts/a/src/x.ts"],
    ["@contexts/a/src/x.ts", "contexts/a/src/x.ts"],
    ["@@x", "@x"], // one '@' only
    ["~", HOME],
    ["~/proj/x.ts", `${HOME}/proj/x.ts`],
    ["@~/proj/x.ts", `${HOME}/proj/x.ts`], // '@' goes first
    ["~x/y", "~x/y"], // not a home reference
    ["file:///repo/contexts/a/src/x.test.ts", "/repo/contexts/a/src/x.test.ts"],
    ["file:///repo/a%20b.ts", "/repo/a b.ts"],
    ["file:x.ts", "file:x.ts"], // no '//': an ordinary name
    ["a b c　d.ts", "a b c d.ts"],
    ["x/@y", "x/@y"],
  ])("%j → %j", (raw, expected) => {
    expect(piPathArgument(raw, HOME)).toEqual({ ok: true, path: expected });
  });

  test("a file URL pi cannot decode is refused", () => {
    const r = piPathArgument("file://remote-host/x", HOME);
    expect(r.ok).toBe(false);
  });
});

describe("Claude Code: forms the gate cannot prove are refused", () => {
  test.each(["~", "~/x", "~user/x", "file:///repo/x.ts", "FILE:x", "@x/y.ts"])("%j is refused", (raw) => {
    const r = claudeCodePathArgument(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/pass the (absolute project )?path/);
  });

  test("plain paths pass unchanged", () => {
    expect(hostPathArgument("claude-code", "/repo/a.ts")).toEqual({ ok: true, path: "/repo/a.ts" });
    expect(hostPathArgument("claude-code", "a/@b.ts")).toEqual({ ok: true, path: "a/@b.ts" });
  });
});

describe("piReadVariant: the spelling pi's read would substitute", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
  const dir = () => { const d = mkdtempSync(join(tmpdir(), "pi-variant-")); dirs.push(d); return d; };

  test("an existing path is opened as written", () => {
    const d = dir();
    writeFileSync(join(d, "a.ts"), "");
    expect(piReadVariant(join(d, "a.ts"))).toBeUndefined();
    expect(piReadVariant(join(d, "missing.ts"))).toBeUndefined();
  });

  test("a curly apostrophe or an AM/PM narrow space is found and reported", () => {
    const d = dir();
    writeFileSync(join(d, "it’s.test.ts"), "");
    writeFileSync(join(d, "shot 1 PM.test.ts"), "");
    expect(piReadVariant(join(d, "it's.test.ts"))).toBe(join(d, "it’s.test.ts"));
    expect(piReadVariant(join(d, "shot 1 PM.test.ts"))).toBe(join(d, "shot 1 PM.test.ts"));
  });
});
