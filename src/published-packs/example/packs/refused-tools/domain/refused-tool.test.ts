import { describe, expect, test } from "bun:test";
import { RefusedTool } from "./refused-tool.ts";
import { refusedToolWireForms } from "./refused-tool.wire-forms.test-support.ts";

describe("RefusedTool — a tool a project refuses, and what to do instead", () => {
  test("parses a tool name and a redirect", () => {
    const wire = { tool: "web", redirect: "Read the docs in docs/ instead" };
    const parsed = RefusedTool.parse(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.tool).toBe("web");
    expect(parsed.value.redirect).toBe("Read the docs in docs/ instead");
    expect<unknown>(parsed.value.toJSON()).toEqual(wire);
    expect(refusedToolWireForms.length).toBeGreaterThan(0);
    for (const form of refusedToolWireForms) expect({ form, parsed: RefusedTool.parse(form).ok }).toEqual({ form, parsed: true });
  });

  test("refuses what is not a refused tool, saying what it is", () => {
    // A host's own tool name is no tool kind (host-neutral events carry a ToolKind): a rule naming one could never match, so it is refused.
    for (const raw of [null, "web", { tool: "", redirect: "x" }, { tool: "web" }, { tool: "web", redirect: "" }, { tool: "WebFetch", redirect: "x" }]) {
      const parsed = RefusedTool.parse(raw);
      expect({ raw, ok: parsed.ok }).toEqual({ raw, ok: false });
      expect({ raw, names: !parsed.ok && parsed.error.includes("{ tool, redirect }") }).toEqual({ raw, names: true });
    }
  });
});
