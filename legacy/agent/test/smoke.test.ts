import { expect, test } from "vitest";

// Phase 0 infrastructure proof: vitest runs TS under ESM with strict types.
// Delete once real suites exist.
test("vitest infrastructure works", () => {
  expect(1 + 1).toBe(2);
});
