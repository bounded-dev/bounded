import { describe, expect, test } from "bun:test";
import { OpenProjectCommand } from "./open-project.command.ts";

describe("OpenProjectCommand laws", () => {
  test("a project root is an absolute directory path", () => {
    const parsed = OpenProjectCommand.parse({ root: "/home/me/project" });
    expect(parsed.ok && parsed.value.root).toBe("/home/me/project");
    expect(OpenProjectCommand.parse({ root: "C:\\\\work\\\\project" }).ok).toBe(true);
  });

  test("refuses anything else, saying what a root is", () => {
    for (const raw of [undefined, null, {}, { root: "" }, { root: "project" }, { root: "./project" }, { root: 7 }, "/home/me"]) {
      expect(OpenProjectCommand.parse(raw)).toEqual({ ok: false, error: "A project root is an absolute directory path, such as /home/me/project" });
    }
  });
});
