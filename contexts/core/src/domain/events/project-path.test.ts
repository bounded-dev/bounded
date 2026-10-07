import { describe, expect, test } from "bun:test";
import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ProjectPath } from "./project-path.ts";

valueObjectLaws("ProjectPath", ProjectPath, ["src/a.ts", "."], ["", "/etc/passwd", "../x", "a/../../x", "C:/x", "a\\b", "~/x"]);

const normalised = (raw: string): unknown => {
  const result = ProjectPath.parse(raw);
  return result.ok ? result.value : result.error;
};

describe("ProjectPath — boundaries", () => {
  test("keeps a plain project-relative path as it is", () => {
    expect(normalised("src/domain/a.ts")).toBe("src/domain/a.ts");
    expect(normalised(".git/config")).toBe(".git/config");
  });

  test("normalises '.', repeated and trailing slashes, and '..' that stays inside", () => {
    expect(normalised("./src//a.ts")).toBe("src/a.ts");
    expect(normalised("src/./lib/")).toBe("src/lib");
    expect(normalised("src/lib/../a.ts")).toBe("src/a.ts");
  });

  test("the project root itself is '.'", () => {
    for (const raw of [".", "./", "src/.."]) expect(normalised(raw)).toBe(".");
  });

  test("refuses an absolute path", () => {
    for (const raw of ["/etc/passwd", "C:/repo/a.ts", "c:", "~/notes"]) {
      expect(normalised(raw)).toBe(`Path '${raw}' is absolute. Give it relative to the project root, such as 'src/a.ts'`);
    }
  });

  test("refuses a path that climbs out of the project", () => {
    for (const raw of ["..", "../other/a.ts", "src/../../a.ts", "./a/../.."]) {
      expect(normalised(raw)).toBe(`Path '${raw}' climbs out of the project with '..'. Only paths inside the project can be checked`);
    }
  });

  test("refuses a backslash: host adapters translate their separators to '/'", () => {
    expect(normalised("src\\a.ts")).toBe("Path 'src\\a.ts' contains '\\'. Separate its parts with '/'");
  });

  test("refuses an empty path, a NUL character and a value that is not a string", () => {
    expect(normalised("")).toBe("A path must not be empty. Use '.' for the project root");
    expect(normalised("a\0b")).toBe("A path must not contain a NUL character");
    expect(ProjectPath.parse(7)).toEqual({ ok: false, error: "A path must be a string" });
  });
});
