import { describe, expect, test } from "bun:test";
import { ProjectPath } from "bounded/domain";
import type { ProjectPathKinds } from "./open-project.contract.ts";

/** A project holding `files` and `dirs` (project-relative), its root, and the port over it. */
export interface PathKindsFixture {
  readonly projectRoot: string;
  readonly pathKinds: ProjectPathKinds;
}

const path = (raw: string): ProjectPath => {
  const parsed = ProjectPath.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

/** The behaviour every ProjectPathKinds must have: it says what is at a project path. */
export function pathKindsConformance(name: string, fixture: (layout: { readonly files: readonly string[]; readonly dirs: readonly string[] }) => Promise<PathKindsFixture>): void {
  describe(`${name} conforms to ProjectPathKinds`, () => {
    test("a file, a directory, the root, or nothing", async () => {
      const { projectRoot, pathKinds } = await fixture({ files: ["src/a.ts"], dirs: ["src"] });
      const kindOf = pathKinds.forProject(projectRoot);
      expect(kindOf(path("src/a.ts"))).toBe("file");
      expect(kindOf(path("src"))).toBe("directory");
      expect(kindOf(path("."))).toBe("directory");
      expect(kindOf(path("src/missing.ts"))).toBe("absent");
    });
  });
}
