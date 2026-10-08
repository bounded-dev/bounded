import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPath } from "bounded/domain";
import { pathKindsConformance } from "../../../application/judge-calls/judge-calls.path-kinds.test-support.ts";
import { FileSystemPathKinds } from "./path-kinds.ts";

pathKindsConformance("FileSystemPathKinds", async ({ files, dirs }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "path-kinds-conformance-"));
  for (const dir of dirs) mkdirSync(join(projectRoot, dir), { recursive: true });
  for (const file of files) writeFileSync(join(projectRoot, file), "x");
  return new FileSystemPathKinds(projectRoot);
});

describe("FileSystemPathKinds: what is at a project path", () => {
  const root = mkdtempSync(join(tmpdir(), "path-kinds-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "a");
  symlinkSync("a.ts", join(root, "src", "alias.ts"));
  const kinds = new FileSystemPathKinds(root);
  const kindOf = (raw: string) => {
    const path = ProjectPath.parse(raw);
    if (!path.ok) throw new Error(path.error);
    return kinds.kindOf(path.value);
  };

  test("a file, a directory, something else (a link, never followed) or nothing", () => {
    expect(kindOf("src/a.ts")).toBe("file");
    expect(kindOf("src")).toBe("directory");
    expect(kindOf(".")).toBe("directory");
    expect(kindOf("src/alias.ts")).toBe("other");
    expect(kindOf("src/missing.ts")).toBe("absent");
  });

  test("cannot tell when the disk cannot say, such as a path through a file", () => {
    expect(kindOf("src/a.ts/inner")).toBeUndefined();
    expect(kindOf("src/a.ts/inner/deeper")).toBeUndefined();
    const sealed = mkdtempSync(join(tmpdir(), "path-kinds-sealed-"));
    mkdirSync(join(sealed, "locked"));
    writeFileSync(join(sealed, "locked", "a.ts"), "a");
    chmodSync(join(sealed, "locked"), 0o000);
    try {
      const path = ProjectPath.parse("locked/a.ts");
      if (!path.ok) throw new Error(path.error);
      expect(new FileSystemPathKinds(sealed).kindOf(path.value)).toBeUndefined();
    } finally {
      chmodSync(join(sealed, "locked"), 0o700);
    }
  });
});
