import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { composedPacks } from "./installed.ts";
import { selectPacks } from "./compose.ts";
import { deliverChecks } from "./ts/pack.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "obligations-"));
  dirs.push(dir);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

// The obligations themselves are tested beside their packs (ts-trpc's
// composition.test.ts, ts-web's web-app-emitter.test.ts). This file holds the
// selection half: which checks a project runs is exactly its composition.
describe("explicit per-project selection", () => {
  test("missing, malformed, unknown, empty and incomplete dependency selections fail closed", () => {
    const cwd = project();
    expect(() => composedPacks(cwd)).toThrow(/bounded compose/);
    for (const value of ['{}', '[]', '["unknown"]', '["ts-web"]', '["ts","ts"]', '["ts","ts-trpc"]']) {
      mkdirSync(join(cwd, ".bounded"), { recursive: true });
      writeFileSync(join(cwd, ".bounded/composed-packs.json"), value);
      expect(() => composedPacks(cwd)).toThrow();
    }
  });
  test("selection changes in one process and never leaks between projects", () => {
    const domain = project(); const web = project();
    selectPacks(domain, ["ts"]); selectPacks(web, ["ts", "ts-hexagonal", "ts-trpc", "ts-web"]);
    expect(composedPacks(domain).read(deliverChecks)).toEqual([]);
    expect(composedPacks(web).read(deliverChecks).map((check) => check.name)).toEqual(["trpc-obligation", "web-obligation"]);
    selectPacks(web, ["ts", "ts-hexagonal", "ts-trpc"]);
    expect(composedPacks(web).read(deliverChecks).map((check) => check.name)).toEqual(["trpc-obligation"]);
    expect(composedPacks(domain).read(deliverChecks)).toEqual([]);
  });
});
