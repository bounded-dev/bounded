import { describe, expect, test } from "bun:test";
import { WatchedPath } from "./watched-path.ts";

const rule = { match: "generated/**", why: "generated/ is written by the generator", redirect: "Change the generator's input instead" };


describe("WatchedPath", () => {
  test("a watched path names files a shell command must not change, why, and what to do instead", () => {
    const every = ["create", "modify", "delete"];
    expect<unknown>(WatchedPath.parse(rule)).toEqual({ ok: true, value: { ...rule, except: [], changes: every } });
    expect<unknown>(WatchedPath.parse({ ...rule, except: ["generated/README.md"] })).toEqual({ ok: true, value: { ...rule, except: ["generated/README.md"], changes: every } });
  });

  test("patterns are project-relative globs", () => {
    for (const match of ["", "/etc/**", "../x/**", "a\\\\b", "a/../b"]) {
      expect(WatchedPath.parse({ ...rule, match })).toEqual({ ok: false, error: `Watched path pattern '${match}' must be a project-relative glob: not empty, no leading '/', no '..', no '\\'` });
    }
    expect(WatchedPath.parse({ ...rule, except: ["../x"] }).ok).toBe(false);
    expect(WatchedPath.parse({ ...rule, except: "generated/a" })).toEqual({ ok: false, error: "A watched path's except is a list of project-relative globs" });
  });

  test("names the changes a command must not make to its files: every one unless said, in a fixed order, at least one", () => {
    expect(WatchedPath.parse({ ...rule, changes: ["delete", "modify", "delete"] })).toMatchObject({ ok: true, value: { changes: ["modify", "delete"] } });
    for (const changes of [[], ["write"], "modify"]) {
      expect(WatchedPath.parse({ ...rule, changes })).toEqual({ ok: false, error: "A watched path's changes name at least one of create, modify and delete" });
    }
  });

  test("says why, and what to do instead", () => {
    for (const broken of [{ ...rule, why: " " }, { ...rule, redirect: "" }, { match: "a/**" }]) {
      expect(WatchedPath.parse(broken)).toEqual({ ok: false, error: "A watched path says why its files are watched and what to do instead: why and redirect are non-empty text" });
    }
  });

  test("refuses something that is not a watched path", () => {
    for (const raw of [null, "generated/**", []]) expect(WatchedPath.parse(raw)).toEqual({ ok: false, error: "A watched path is { match, except?, why, redirect }" });
  });
});
