import { describe, expect, test } from "bun:test";
import { ProjectPath } from "bounded/domain";
import type { PathKinds } from "./judge-calls.contract.ts";

const path = (raw: string): ProjectPath => {
  const parsed = ProjectPath.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

/** The behaviour every PathKinds must have: it says what is at a project path. `fixture` gives one over a project holding `files` and `dirs`. */
export function pathKindsConformance(name: string, fixture: (layout: { readonly files: readonly string[]; readonly dirs: readonly string[] }) => Promise<PathKinds>): void {
  describe(`${name} conforms to PathKinds`, () => {
    test("a file, a directory, the root, or nothing", async () => {
      const kinds = await fixture({ files: ["src/a.ts"], dirs: ["src"] });
      expect(kinds.kindOf(path("src/a.ts"))).toBe("file");
      expect(kinds.kindOf(path("src"))).toBe("directory");
      expect(kinds.kindOf(path("."))).toBe("directory");
      expect(kinds.kindOf(path("src/missing.ts"))).toBe("absent");
    });
  });
}
