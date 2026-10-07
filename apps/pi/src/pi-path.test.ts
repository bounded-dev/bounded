import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { locator, piRewrite } from "./pi-path.ts";

const HOME = "/home/agent";

describe("piRewrite — the rewrite pi applies before it uses a path", () => {
  test("turns unicode spaces into plain spaces", () => {
    expect(piRewrite("my file name　.ts", HOME)).toEqual({ ok: true, value: "my file name .ts" });
  });

  test("strips one leading @, not two", () => {
    expect(piRewrite("@src/a.ts", HOME)).toEqual({ ok: true, value: "src/a.ts" });
    expect(piRewrite("@@src/a.ts", HOME)).toEqual({ ok: true, value: "@src/a.ts" });
  });

  test("expands ~ and ~/ to the home directory, but not ~name", () => {
    expect(piRewrite("~", HOME)).toEqual({ ok: true, value: HOME });
    expect(piRewrite("~/notes.md", HOME)).toEqual({ ok: true, value: `${HOME}/notes.md` });
    expect(piRewrite("@~/notes.md", HOME)).toEqual({ ok: true, value: `${HOME}/notes.md` });
    expect(piRewrite("~other/notes.md", HOME)).toEqual({ ok: true, value: "~other/notes.md" });
  });

  test("decodes a file:// URL, and refuses one it cannot decode", () => {
    expect(piRewrite("file:///work/my%20project/a.ts", HOME)).toEqual({ ok: true, value: "/work/my project/a.ts" });
    const bad = piRewrite("file://remote-host/a.ts", HOME);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain("file://remote-host/a.ts");
  });

  test("leaves a plain path alone", () => {
    expect(piRewrite("src/a.ts", HOME)).toEqual({ ok: true, value: "src/a.ts" });
  });
});

// tmpdir() is itself behind a link on some systems, so the root is given as
// spelled, and the locator must still agree with where files really are.
const spelled = mkdtempSync(join(tmpdir(), "bounded-pi-path-"));
const root = join(spelled, "project");
const outside = join(spelled, "outside");
mkdirSync(join(root, "src", "deep"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(root, "src", "a.ts"), "");
writeFileSync(join(outside, "secret.txt"), "");
symlinkSync(join(root, "src"), join(root, "alias"));
symlinkSync(outside, join(root, "escape"));
symlinkSync(join(outside, "secret.txt"), join(root, "secret-link.txt"));
symlinkSync(join(outside, "not-yet.txt"), join(root, "dangling.txt"));

const locate = locator(root, HOME);
const at = (raw: string, base = root) => locate(raw, base);

describe("locator — where a pi path argument really acts, relative to the project", () => {
  test("a relative path is taken from the base directory", () => {
    expect<unknown>(at("src/a.ts")).toEqual({ ok: true, value: { path: "src/a.ts", absolute: join(realpathSync(root), "src", "a.ts"), exists: true } });
    expect(at("a.ts", join(root, "src"))).toMatchObject({ ok: true, value: { path: "src/a.ts" } });
  });

  test("an absolute path under the project is made project-relative", () => {
    expect(at(join(root, "src", "a.ts"))).toMatchObject({ ok: true, value: { path: "src/a.ts" } });
    expect(at(join(realpathSync(root), "src", "a.ts"))).toMatchObject({ ok: true, value: { path: "src/a.ts" } });
    expect(at(root)).toMatchObject({ ok: true, value: { path: "." } });
  });

  test("pi's rewrite applies first: @, unicode spaces and file:// URLs", () => {
    expect(at("@src/a.ts")).toMatchObject({ ok: true, value: { path: "src/a.ts" } });
    expect(at(pathToFileURL(join(root, "src", "a.ts")).href)).toMatchObject({ ok: true, value: { path: "src/a.ts" } });
    expect(at("src/new file.ts")).toMatchObject({ ok: true, value: { path: "src/new file.ts", exists: false } });
  });

  test("a path that does not exist yet is located, and says so", () => {
    expect(at("src/deep/new/file.ts")).toMatchObject({ ok: true, value: { path: "src/deep/new/file.ts", exists: false } });
  });

  test("refuses a path outside the project, naming it", () => {
    for (const raw of ["../outside/secret.txt", join(outside, "secret.txt"), "~/notes.md", "/etc/hosts"]) {
      const result = at(raw);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain(raw);
      expect(!result.ok && result.error).toContain("outside the project");
    }
  });

  test("judges a link by where it lands", () => {
    expect(at("alias/a.ts")).toMatchObject({ ok: true, value: { path: "src/a.ts", exists: true } });
    for (const raw of ["escape/secret.txt", "secret-link.txt", "escape/new.txt"]) {
      const result = at(raw);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain("through a link");
    }
  });

  test("refuses a dangling link: writing through it would create its target, wherever that is", () => {
    const result = at("dangling.txt");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("dangling.txt");
  });

  test("refuses a NUL character instead of guessing", () => {
    expect(at("src/a.ts\0.txt").ok).toBe(false);
  });

  test("refuses when the project root itself cannot be found", () => {
    const result = locator(join(spelled, "missing"), HOME)("a.ts", join(spelled, "missing"));
    expect(result.ok).toBe(false);
  });
});
