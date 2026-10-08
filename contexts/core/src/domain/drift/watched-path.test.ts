import { describe, expect, test } from "bun:test";
import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { WatchedPath } from "./watched-path.ts";

const rule = { match: "generated/**", why: "generated/ is written by the generator", redirect: "Change the generator's input instead" };

valueObjectLaws("WatchedPath", WatchedPath, [rule, { ...rule, match: "build/**", except: ["build/keep.txt"] }], [{ ...rule, match: "/etc/**" }, { ...rule, why: " " }, { ...rule, except: "x" }]);

describe("WatchedPath", () => {
  test("a watched path names files a shell command must not change, why, and what to do instead", () => {
    expect<unknown>(WatchedPath.parse(rule)).toEqual({ ok: true, value: { ...rule, except: [] } });
    expect<unknown>(WatchedPath.parse({ ...rule, except: ["generated/README.md"] })).toEqual({ ok: true, value: { ...rule, except: ["generated/README.md"] } });
  });

  test("patterns are project-relative globs", () => {
    for (const match of ["", "/etc/**", "../x/**", "a\\\\b", "a/../b"]) {
      expect(WatchedPath.parse({ ...rule, match })).toEqual({ ok: false, error: `Watched path pattern '${match}' must be a project-relative glob: not empty, no leading '/', no '..', no '\\'` });
    }
    expect(WatchedPath.parse({ ...rule, except: ["../x"] }).ok).toBe(false);
    expect(WatchedPath.parse({ ...rule, except: "generated/a" })).toEqual({ ok: false, error: "A watched path's except is a list of project-relative globs" });
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
