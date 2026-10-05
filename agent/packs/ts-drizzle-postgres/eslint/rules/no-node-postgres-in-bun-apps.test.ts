import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, test } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { composePacks } from "../../../../src/socket-registry.ts";
import { INSTALLED_PACKS } from "../../../installed.ts";
import { lintSrcRuleId, lintSrcRules } from "../../../ts/pack.ts";
import { noNodePostgresInBunApps } from "./no-node-postgres-in-bun-apps.ts";

// Final review of #52, minor 9. Every app pins `pg` as a dev dependency so
// the generated smoke-test database support can migrate with node-postgres
// (ADR 2026-072). That trade makes `pg` resolvable from a Bun app's own
// code, where it would ship a second driver beside `drizzle-orm/bun-sql`;
// this rule keeps a Bun app's production source off it. Node apps (bundled
// with `--target node`) and test-side files are out of scope.

const root = mkdtempSync(join(tmpdir(), "no-node-postgres-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function app(name: string, build: string | undefined): string {
  const dir = join(root, "apps", name);
  mkdirSync(join(dir, "src", "server"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: build === undefined ? {} : { build } }));
  return join(dir, "src", "server", "main.ts");
}

const WEB = app("web", undefined);
const LAMBDA = app("lambdas", "bun build ./src/*.ts --outdir dist --target node");

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-node-postgres-in-bun-apps", noNodePostgresInBunApps, {
  valid: [
    { code: `import { drizzle } from "drizzle-orm/bun-sql";\nexport const d = drizzle;`, filename: WEB },
    { code: `import type { Pool } from "pg";\nexport type P = Pool;`, filename: WEB },
    { code: `import { Pool } from "pg";\nexport const p = Pool;`, filename: LAMBDA },
    { code: `import { Pool } from "pg";\nexport const p = Pool;`, filename: join(root, "contexts", "pm", "src", "x.ts") },
  ],
  invalid: [
    { code: `import { Pool } from "pg";\nexport const p = Pool;`, filename: WEB, errors: [{ messageId: "nodePostgres", data: { source: "pg" } }] },
    { code: `import { drizzle } from "drizzle-orm/node-postgres";\nexport const d = drizzle;`, filename: WEB, errors: [{ messageId: "nodePostgres" }] },
    { code: `export const load = () => import("pg");`, filename: WEB, errors: [{ messageId: "nodePostgres" }] },
  ],
});

describe("the contribution", () => {
  test("ts-drizzle-postgres contributes it to the builder's src lint", () => {
    const ids = composePacks(INSTALLED_PACKS, ["ts", "ts-hexagonal", "ts-drizzle-postgres"]).read(lintSrcRules).map(lintSrcRuleId);
    expect(ids).toContain("bounded-ts-drizzle-postgres/no-node-postgres-in-bun-apps");
  });
});
