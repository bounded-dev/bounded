import { describe, expect, test } from "bun:test";
import { PackName } from "./pack-name.ts";

describe("PackName — boundaries", () => {
  test("accepts lowercase words joined by single hyphens", () => {
    for (const raw of ["core", "path-gate", "a", "a1", "web-2-api"]) {
      const result = PackName.parse(raw);
      expect(result.ok && result.value.value).toBe(raw);
    }
  });

  test("refuses anything else with a reason that names it and shows the form", () => {
    expect(PackName.parse("Path-Gate")).toEqual({
      ok: false,
      error: "Pack name 'Path-Gate' must be lowercase words joined by single hyphens, such as 'path-gate'",
    });
    for (const raw of ["", " core", "core ", "-core", "core-", "a--b", "a_b", "a.b", "1core", "é"]) {
      expect(PackName.parse(raw).ok).toBe(false);
    }
  });

  test("refuses every name that could reach outside the packs' folder", () => {
    for (const raw of ["..", ".", "../core", "core/..", "a/b", "/core", "core\\x", "~core", "core\u0000"]) {
      expect(PackName.parse(raw).ok).toBe(false);
    }
  });

  test("refuses a value that is not a string", () => {
    expect(PackName.parse(7)).toEqual({ ok: false, error: "A pack name must be a string" });
  });

  test("its wire form is the name", () => {
    const result = PackName.parse("path-gate");
    expect(result.ok && result.value.toJSON()).toBe("path-gate");
  });
});
