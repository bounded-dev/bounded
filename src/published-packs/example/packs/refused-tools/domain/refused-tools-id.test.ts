import { describe, expect, test } from "bun:test";
import { refusedToolsId } from "./refused-tools-id.ts";

describe("refusedToolsId", () => {
  test("is bounded-example/refused-tools, rooted at its own package", () => {
    expect(refusedToolsId.value).toBe("bounded-example/refused-tools");
  });
});
