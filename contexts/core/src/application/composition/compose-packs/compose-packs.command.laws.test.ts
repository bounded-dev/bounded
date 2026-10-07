import { describe, expect, test } from "bun:test";
import { ComposePacksCommand } from "./compose-packs.command.ts";

const INVALID = { ok: false as const, error: "Invalid compose packs input: give { selected: [pack names] }" };

describe("ComposePacksCommand laws", () => {
  test("refuses anything that is not an object with a list of strings", () => {
    for (const raw of [undefined, null, 0, "core", [], {}, { selected: "core" }, { selected: [1] }, { selected: null }]) {
      expect(ComposePacksCommand.parse(raw)).toEqual(INVALID);
    }
  });

  test("keeps valid names in order, and an empty selection", () => {
    const result = ComposePacksCommand.parse({ selected: ["path-gate", "core"] });
    expect(result.ok && result.value.selected.map((n) => n.value)).toEqual(["path-gate", "core"]);
    expect(ComposePacksCommand.parse({ selected: [] }).ok).toBe(true);
  });

  test("refuses with the first invalid name's reason", () => {
    expect(ComposePacksCommand.parse({ selected: ["core", "Bad", "../x"] })).toEqual({
      ok: false,
      error: "Pack name 'Bad' must be lowercase words joined by single hyphens, such as 'path-gate'",
    });
  });

  test("ignores fields the input does not declare", () => {
    const result = ComposePacksCommand.parse({ selected: ["core"], extra: true });
    expect(result.ok && result.value.selected.map((n) => n.value)).toEqual(["core"]);
  });
});
