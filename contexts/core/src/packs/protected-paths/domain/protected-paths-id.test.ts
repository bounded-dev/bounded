import { describe, expect, test } from "bun:test";
import { protectedPathsId } from "./protected-paths-id.ts";

describe("protectedPathsId", () => {
  test("is bounded/protected-paths", () => {
    expect(protectedPathsId.value).toBe("bounded/protected-paths");
  });
});
