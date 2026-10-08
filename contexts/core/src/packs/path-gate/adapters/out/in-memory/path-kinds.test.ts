import { describe, expect, test } from "bun:test";
import { ProjectPath } from "bounded/domain";
import { pathKindsConformance } from "../../../application/judge-calls/judge-calls.path-kinds.test-support.ts";
import { InMemoryPathKinds } from "./path-kinds.ts";

pathKindsConformance("InMemoryPathKinds", async ({ files, dirs }) => new InMemoryPathKinds(Object.fromEntries([...files.map((file) => [file, "file"] as const), ...dirs.map((dir) => [dir, "directory"] as const)])));

describe("InMemoryPathKinds: what is at a path, as given", () => {
  test("a path given as unknown cannot be told", () => {
    const path = ProjectPath.parse("src/a.ts");
    if (!path.ok) throw new Error(path.error);
    expect(new InMemoryPathKinds({ "src/a.ts": "unknown" }).kindOf(path.value)).toBeUndefined();
  });
});
