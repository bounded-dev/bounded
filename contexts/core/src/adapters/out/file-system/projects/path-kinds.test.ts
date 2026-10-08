import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemProjectPathKinds } from "./path-kinds.ts";

describe("FileSystemProjectPathKinds: what is at a project path", () => {
  const root = mkdtempSync(join(tmpdir(), "path-kinds-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "a");
  symlinkSync("a.ts", join(root, "src", "alias.ts"));
  const kindOf = new FileSystemProjectPathKinds().forProject(root);

  test("a file, a directory, something else (a link, never followed) or nothing", () => {
    expect(kindOf("src/a.ts")).toBe("file");
    expect(kindOf("src")).toBe("directory");
    expect(kindOf(".")).toBe("directory");
    expect(kindOf("src/alias.ts")).toBe("other");
    expect(kindOf("src/missing.ts")).toBe("absent");
  });

  test("cannot tell for a path that is not a plain project path", () => {
    expect(kindOf("../outside")).toBeUndefined();
    expect(kindOf("/etc/passwd")).toBeUndefined();
    expect(kindOf("")).toBeUndefined();
  });
});
