import { describe, expect, test } from "bun:test";
import { RefusedTool } from "./refused-tool.ts";
import { refusedToolWireForms } from "./refused-tool.wire-forms.test-support.ts";

describe("RefusedTool laws", () => {
  test("its wire form parses back to an equal value, and it is frozen", () => {
    expect(refusedToolWireForms.length).toBeGreaterThan(0);
    for (const form of refusedToolWireForms) {
      const parsed = RefusedTool.parse(form);
      expect({ form, ok: parsed.ok }).toEqual({ form, ok: true });
      if (!parsed.ok) continue;
      const again = RefusedTool.parse(parsed.value.toJSON());
      expect({ form, ok: again.ok, equal: again.ok && again.value.equals(parsed.value) }).toEqual({ form, ok: true, equal: true });
      expect({ form, frozen: Object.isFrozen(parsed.value) }).toEqual({ form, frozen: true });
      // Another valid tool kind, so the comparison is of two refused tools: a tool that is no kind would not parse.
      const other = RefusedTool.parse({ tool: parsed.value.tool === "web" ? "shell" : "web", redirect: parsed.value.redirect });
      expect({ form, otherParsed: other.ok }).toEqual({ form, otherParsed: true });
      expect({ form, equal: other.ok && other.value.equals(parsed.value) }).toEqual({ form, equal: false });
    }
  });
});
