import { describe, expect, test } from "bun:test";
import { ComposePacksCommand } from "./compose-packs.command.ts";

const INVALID = { ok: false as const, error: "Invalid compose packs input: give { listedPackIds: [pack ids] }" };

describe("ComposePacksCommand laws", () => {
  test("refuses anything that is not an object with a list of strings", () => {
    for (const raw of [undefined, null, 0, "core", [], {}, { listedPackIds: "bounded/core" }, { listedPackIds: [1] }, { listedPackIds: null }]) {
      expect(ComposePacksCommand.parse(raw)).toEqual(INVALID);
    }
  });

  test("validates each id through PackId, in order", () => {
    const result = ComposePacksCommand.parse({ listedPackIds: ["bounded/protected-paths", "bounded/core"] });
    expect(result.ok && result.value.listedPackIds.map((id) => id.value)).toEqual(["bounded/protected-paths", "bounded/core"]);
    expect(ComposePacksCommand.parse({ listedPackIds: [] }).ok).toBe(true);
    expect(ComposePacksCommand.parse({ listedPackIds: ["bounded/core", "Bad", "../x"] })).toEqual({
      ok: false,
      error: "Pack id 'Bad' must be an npm package name, '/', and lowercase words joined by hyphens, such as 'bounded/protected-paths'",
    });
  });

  test("ignores fields the input does not declare", () => {
    const result = ComposePacksCommand.parse({ listedPackIds: ["bounded/core"], extra: true });
    expect(result.ok && result.value.listedPackIds.map((id) => id.value)).toEqual(["bounded/core"]);
  });
});
