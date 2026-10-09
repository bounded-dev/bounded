import { describe, expect, test } from "bun:test";
import { effectGuardsPoint, functionOf, toolUseGuardsPoint } from "./guard-points.ts";

describe("the core pack's point declarations", () => {
  test("a function point takes a function, and refuses anything else", () => {
    const guard = () => undefined;
    expect(functionOf(guard)).toEqual({ ok: true, value: guard });
    expect(functionOf("not a function")).toEqual({ ok: false, error: "a guard is a function" });
    expect(toolUseGuardsPoint.check(guard).ok).toBe(true);
  });

  test("the effect guards are one point per effect kind", () => {
    expect(Object.keys(effectGuardsPoint.members).sort()).toEqual(["delegate", "execute", "fetch", "invoke", "list", "read", "write"]);
  });
});
