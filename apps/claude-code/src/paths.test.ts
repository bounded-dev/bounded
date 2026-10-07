import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectPaths } from "./paths.ts";

// A project and a sibling directory outside it, under a temporary directory
// that may itself sit behind a link (macOS's /var -> /private/var).
let base = "";
let root = "";
let outside = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "bounded-cc-paths-"));
  root = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(outside, "secret"), "");
  symlinkSync(join(root, "src"), join(root, "inner-link"));
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(outside, "secret"), join(root, "src", "secret-link"));
  symlinkSync(join(base, "missing"), join(root, "dangling"));
  symlinkSync(join(root, "src"), join(base, "into-project"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const resolved = (raw: string, cwd = root): string => {
  const result = projectPaths(root).resolve(raw, cwd);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value.path;
};
const refused = (raw: string, cwd = root): string => {
  const result = projectPaths(root).resolve(raw, cwd);
  if (result.ok) throw new Error(`resolved to ${result.value.path}`);
  return result.error.reason;
};

describe("projectPaths: a Claude Code path to a project-relative one", () => {
  test("an absolute path under the project becomes project-relative", () => {
    expect(resolved(join(root, "src", "a.ts"))).toBe("src/a.ts");
    expect(resolved(root)).toBe(".");
  });

  test("a relative path is resolved against the session's directory, not the project root", () => {
    expect(resolved("a.ts", join(root, "src"))).toBe("src/a.ts");
    expect(resolved(".", join(root, "src"))).toBe("src");
    expect(resolved("src/./deep/../a.ts")).toBe("src/a.ts");
  });

  test("a path that does not exist yet is judged by its existing parent", () => {
    expect(resolved(join(root, "src", "new", "file.ts"))).toBe("src/new/file.ts");
    expect(resolved(join(root, "inner-link", "new.ts"))).toBe("src/new.ts");
  });

  test("says whether the path exists, so a write can be told apart as create or modify", () => {
    const exists = (raw: string): boolean => {
      const result = projectPaths(root).resolve(raw, root);
      if (!result.ok) throw new Error(result.error.reason);
      return result.value.exists;
    };
    expect(exists("src/a.ts")).toBe(true);
    expect(exists("inner-link/a.ts")).toBe(true);
    expect(exists("src/new.ts")).toBe(false);
  });

  test("a link inside the project is judged by where it lands", () => {
    expect(resolved(join(root, "inner-link", "a.ts"))).toBe("src/a.ts");
    expect(resolved(join(base, "into-project", "a.ts"))).toBe("src/a.ts");
  });

  test("a link that lands outside the project is refused, naming where it lands", () => {
    expect(refused(join(root, "escape", "secret"))).toMatch(/^Path '.*escape\/secret' is a link that lands outside the project, at '.*outside\/secret'$/);
    expect(refused(join(root, "src", "secret-link"))).toMatch(/lands outside the project/);
    expect(refused(join(root, "escape", "new-file"))).toMatch(/lands outside the project/);
  });

  test("a link whose target does not exist is refused: where a write would land cannot be judged", () => {
    expect(refused(join(root, "dangling"))).toMatch(/^Path '.*dangling' is a link to something that does not exist/);
  });

  test("a path outside the project is refused", () => {
    expect(refused(join(outside, "secret"))).toMatch(/^Path '.*outside\/secret' is outside the project at '.*project'$/);
    expect(refused("../outside/secret")).toMatch(/is outside the project/);
    expect(refused("a.ts", outside)).toMatch(/is outside the project/);
  });

  test("forms Claude Code does not expand are refused, never guessed at", () => {
    expect(refused("~/x")).toBe("Path '~/x' starts with '~'. Give the path itself: absolute under the project, or relative to it");
    expect(refused("~")).toBe("Path '~' starts with '~'. Give the path itself: absolute under the project, or relative to it");
    expect(refused("@src/a.ts")).toBe("Path '@src/a.ts' starts with '@'. Give the path itself: absolute under the project, or relative to it");
    expect(refused("file:///etc/passwd")).toBe("Path 'file:///etc/passwd' starts with 'file:'. Give the path itself: absolute under the project, or relative to it");
    expect(refused("")).toBe("A path must not be empty");
    expect(refused("a\0b")).toBe("A path must not contain a NUL character");
  });

  test("a project directory that does not exist refuses every path", () => {
    const result = projectPaths(join(base, "nowhere")).resolve("a.ts", join(base, "nowhere"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toMatch(/^The project directory '.*nowhere' cannot be read: /);
  });

  test("every refusal says what to do next", () => {
    const result = projectPaths(root).resolve(join(outside, "secret"), root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.redirect).toBe("Use a path inside the project; a link must land inside it too");
  });
});
