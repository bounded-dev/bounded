import { describe, expect, test } from "bun:test";
import { ExtensionPointId } from "./extension-point-id.ts";

describe("ExtensionPointId — boundaries", () => {
  test("accepts dot-separated segments of lowercase words joined by hyphens", () => {
    for (const raw of ["core.tool-use-guards", "path-gate.role-path-rules", "a", "a.b.c", "x1.y2"]) {
      const result = ExtensionPointId.parse(raw);
      expect(result.ok && result.value.value).toBe(raw);
    }
  });

  test("refuses anything else with a reason that names it and shows the form", () => {
    expect(ExtensionPointId.parse("Core.Guards")).toEqual({
      ok: false,
      error:
        "Extension point id 'Core.Guards' must be lowercase words joined by hyphens, in dot-separated segments, such as 'path-gate.protected-paths'",
    });
    for (const raw of ["", "a.", ".a", "a..b", "a-.b", "a b", "a/b", "a_b", "1a"]) {
      expect(ExtensionPointId.parse(raw).ok).toBe(false);
    }
  });

  test("refuses a value that is not a string", () => {
    expect(ExtensionPointId.parse(null)).toEqual({ ok: false, error: "An extension point id must be a string" });
  });
});
