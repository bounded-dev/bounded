// Test support: the hexagonal layout (TN-26-012) overlaid on a real
// composition, for suites that drive the path gate through real project
// directories.
//
// No installed pack contributes source roots or test suffixes yet — the
// layout pack does (ADR 2026-063) — so a suite that composes the language
// pack gets these values through `vi.mock` of pack-contrib.ts:
//
//   vi.mock("./pack-contrib.ts", async (importOriginal) => {
//     const { withHexagonalLayout } = await import("./hexagonal-layout.test-support.ts");
//     return withHexagonalLayout(await importOriginal());
//   });
//
// The real readers always run first, so an unreadable composition stays
// unreadable: only a readable one gains the layout.
import type * as PackContrib from "./pack-contrib.ts";
import type { PathLayout } from "./path-policy.ts";

export const HEXAGONAL_ROOTS: readonly string[] = ["apps/*/src", "contexts/*/src"];
export const HEXAGONAL_TEST_SUFFIXES: readonly string[] = [".test.ts", ".test.tsx", ".test-support.ts"];
export const HEXAGONAL_GENERATED: readonly string[] = ["**/*.laws.test.ts", "contexts/*/src/application/*/*/*.command.ts"];

type Contrib = typeof PackContrib;

export function withHexagonalLayout(actual: Contrib): Contrib {
  const layout = (cwd: string, packsDir?: string): PathLayout => {
    const real = actual.pathLayoutOrUnreadable(cwd, packsDir);
    if (real.sourceRoots === "unreadable") return real;
    const suffixes = actual.contractFileSuffixes(cwd, packsDir);
    return {
      sourceRoots: [...HEXAGONAL_ROOTS],
      contractGlobs: HEXAGONAL_ROOTS.flatMap((root) => suffixes.map((suffix) => `${root}/**/*${suffix}`)),
      testSuffixes: [...HEXAGONAL_TEST_SUFFIXES],
      generatedGlobs: real.generatedGlobs === "unreadable" ? "unreadable" : [...real.generatedGlobs, ...HEXAGONAL_GENERATED],
    };
  };
  return {
    ...actual,
    sourceRoots: (cwd: string, packsDir?: string): string[] => {
      actual.sourceRoots(cwd, packsDir);
      return [...HEXAGONAL_ROOTS];
    },
    pathLayoutOrUnreadable: layout,
  };
}
