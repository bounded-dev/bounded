import { describe, expect, test } from "bun:test";
import { ComposePacksCommand } from "./compose-packs.command.ts";

const INVALID = { ok: false as const, error: "Invalid compose packs input: give { selectedPackIds: [pack ids] }" };

describe("ComposePacksCommand laws", () => {
  test("refuses anything that is not an object with a list of strings", () => {
    for (const raw of [undefined, null, 0, "core", [], {}, { selectedPackIds: "bounded/core" }, { selectedPackIds: [1] }, { selectedPackIds: null }]) {
      expect(ComposePacksCommand.parse(raw)).toEqual(INVALID);
    }
  });

  test("validates each id through PackId, in order", () => {
    const result = ComposePacksCommand.parse({ selectedPackIds: ["bounded/path-gate", "bounded/core"] });
    expect(result.ok && result.value.selectedPackIds.map((id) => id.value)).toEqual(["bounded/path-gate", "bounded/core"]);
    expect(ComposePacksCommand.parse({ selectedPackIds: [] }).ok).toBe(true);
    expect(ComposePacksCommand.parse({ selectedPackIds: ["bounded/core", "Bad", "../x"] })).toEqual({
      ok: false,
      error: "Pack id 'Bad' must be an npm package name, '/', and lowercase words joined by hyphens, such as 'bounded/path-gate'",
    });
  });

  test("ignores fields the input does not declare", () => {
    const result = ComposePacksCommand.parse({ selectedPackIds: ["bounded/core"], extra: true });
    expect(result.ok && result.value.selectedPackIds.map((id) => id.value)).toEqual(["bounded/core"]);
  });
});
