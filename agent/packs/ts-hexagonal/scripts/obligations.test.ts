import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { appSmokeTests, SMOKE_TEST } from "./obligations.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tree(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hexagonal-smoke-"));
  tmpDirs.push(dir);
  for (const rel of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "export {};\n");
  }
  return dir;
}

// The app smoke tests need the apps' database, which the builder's run may not
// have (issue #48): the Postgres pack leaves them out by this list.
describe("the app smoke tests", () => {
  test("the app smoke test finder lists every composition-root.test.ts under apps", () => {
    const dir = tree([
      "apps/web/src/server/composition-root.test.ts",
      "apps/web/src/server/composition-root.ts",
      "apps/mcp/src/composition-root.test.ts",
      "apps/mcp/node_modules/x/composition-root.test.ts",
      "contexts/pm/src/composition-root.test.ts",
      "contexts/pm/src/domain/note.test.ts",
    ]);
    expect(SMOKE_TEST).toBe("composition-root.test.ts");
    expect(appSmokeTests(dir)).toEqual([
      "apps/mcp/src/composition-root.test.ts",
      "apps/web/src/server/composition-root.test.ts",
    ]);
  });
});
