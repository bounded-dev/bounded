// Generated from create-project.contract.ts by the ts-hexagonal pack; do not edit.
// The laws every CreateProjectCommand obeys, whatever its value objects accept.
import { describe, expect, test } from "bun:test";
import { ProjectName } from "@example/project-management/domain";
import { CreateProjectCommand } from "./create-project.command.ts";

const INVALID = { ok: false as const, error: "Invalid create project input" };
const STRINGS = ["", " ", "a", "Hello, world", "not-a-uuid", "00000000-0000-4000-8000-000000000000", "x".repeat(300)];

function wire(i: number, j: number): Record<string, unknown> {
  return {
    name: STRINGS[i % STRINGS.length],
  };
}

const cases = Array.from({ length: 49 }, (_, n) => wire(Math.floor(n / 7), n % 7));

describe("CreateProjectCommand laws", () => {
  test("refuses anything that is not an object", () => {
    for (const raw of [undefined, null, 0, 1, "", "text", true, [], [wire(0, 0)]]) {
      expect(CreateProjectCommand.parse(raw)).toEqual(INVALID);
    }
  });

  test("refuses input missing any field", () => {
    for (const field of ["name"]) {
      const raw = wire(0, 0);
      delete raw[field];
      expect(CreateProjectCommand.parse(raw)).toEqual(INVALID);
    }
  });

  test("refuses a field of the wrong wire type", () => {
    expect(CreateProjectCommand.parse({ ...wire(0, 0), name: 42 })).toEqual(INVALID);
  });

  test("validates each field through its value object, in declaration order", () => {
    for (const raw of cases) {
      const result = CreateProjectCommand.parse(raw);
      const name = ProjectName.parse(raw.name);
      if (!name.ok) {
        expect(result).toEqual(name);
        continue;
      }
      if (!result.ok) throw new Error(`expected ${JSON.stringify(raw)} to parse`);
      expect(result.value.name.equals(name.value)).toBe(true);
    }
  });

  test("ignores fields the input does not declare", () => {
    for (const raw of cases) {
      const plain = JSON.stringify(CreateProjectCommand.parse(raw));
      expect(JSON.stringify(CreateProjectCommand.parse({ ...raw, undeclared: "x" }))).toBe(plain);
    }
  });
});
