import { describe, expect, test } from "bun:test";
import { prereqsId } from "./prereqs-id.ts";

describe("prereqsId", () => {
  test("the pack's id is bounded/prereqs", () => {
    expect(prereqsId.value).toBe("bounded/prereqs");
  });
});
