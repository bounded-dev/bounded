import { describe, expect, test } from "bun:test";
import { pathGateId } from "./path-gate-id.ts";

describe("pathGateId", () => {
  test("is bounded/path-gate", () => {
    expect(pathGateId.value).toBe("bounded/path-gate");
  });
});
