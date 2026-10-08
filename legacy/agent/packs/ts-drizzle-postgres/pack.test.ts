// ts-drizzle-postgres's data half (contrib.json) as every reader sees it:
// the adapter technology and its exact pins, generated-file globs, root
// config, shipped scripts and ignore rules.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { fileNameGlobs, generatedFileGlobsFor, projectConfigSources, projectIgnoreRules } from "../../src/pack-contrib.ts";
import { adapterTechnologies } from "../ts/pack.ts";
import { packageFor, shippedFiles } from "../ts/scripts/project-package.ts";
import { POSTGRES_IMAGE } from "./scripts/emit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..", "..");
const packsDir = join(agentRoot, "packs");
const PACKS = ["ts", "ts-hexagonal", "ts-drizzle-postgres"];

describe("the drizzle adapter technology", () => {
  // ts-hexagonal, composed underneath, contributes in-memory and console.
  const drizzle = adapterTechnologies(PACKS, packsDir).find((t) => t.id === "drizzle");

  test("is an out, storage technology contributed by this pack", () => {
    expect(drizzle).toMatchObject({ pack: "ts-drizzle-postgres", id: "drizzle", direction: "out", storage: true, database: "type" });
    expect(adapterTechnologies(PACKS, packsDir).filter((t) => t.pack === "ts-drizzle-postgres")).toHaveLength(1);
  });

  test("gives each context the example's own db:generate and db:migrate scripts", () => {
    expect(drizzle!.workspaceScripts).toEqual({
      "db:generate": "drizzle-kit generate",
      "db:migrate": "bun --env-file=../../.env run drizzle-kit migrate",
    });
  });

  test("pins exact versions of the example's packages, which the harness itself installs", () => {
    expect(drizzle!.pins).toEqual({
      dependencies: { "drizzle-orm": "0.45.3", pg: "8.23.1" },
      devDependencies: { "@testcontainers/postgresql": "12.2.0", "@types/pg": "8.23.1", "drizzle-kit": "0.31.11", testcontainers: "12.2.0" },
    });
    // Project lockfiles are derived from the harness's own (ADR LEG-2026-054), and
    // the pack's tests run against these very versions.
    const harness = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    for (const [name, version] of Object.entries({ ...drizzle!.pins.dependencies, ...drizzle!.pins.devDependencies })) {
      expect(harness.devDependencies[name], name).toBe(version);
    }
  });
});

describe("generated files (ADR LEG-2026-058)", () => {
  test("the globs are valid and cover TN-26-012's drizzle rows plus the per-context config", () => {
    const hexagonal = new Set(generatedFileGlobsFor(["ts", "ts-hexagonal"], packsDir));
    expect(generatedFileGlobsFor(PACKS, packsDir).filter((g) => !hexagonal.has(g))).toEqual([
      "apps/**/app-test-database.test-support.ts",
      "contexts/*/drizzle.config.ts",
      "contexts/*/src/adapters/out/drizzle/drizzle-database.ts",
      "contexts/*/src/adapters/out/drizzle/drizzle-test-database.test-support.ts",
      "contexts/*/src/adapters/out/drizzle/migrations/**",
      "contexts/*/src/adapters/out/drizzle/schema/*.schema.ts",
    ]);
  });
});

describe("root config, scripts and ignore rules", () => {
  test("docker-compose.yml and .env.example are generated config, and agree with each other and the store tests", () => {
    const sources = projectConfigSources(PACKS, packsDir).filter((s) => s.pack === "ts-drizzle-postgres");
    expect(sources.map((s) => s.target)).toEqual(["docker-compose.yml", ".env.example"]);
    expect(fileNameGlobs("projectConfigNames", PACKS, packsDir)).toEqual(expect.arrayContaining(["docker-compose.yml", ".env.example"]));
    const compose = readFileSync(join(here, "reference/docker-compose.yml"), "utf8");
    expect(compose).toContain(`    image: ${POSTGRES_IMAGE}\n`);
    const [user, password, db] = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]
      .map((key) => new RegExp(`${key}: (\\S+)`).exec(compose)![1]);
    // The database is the project's name, as in the worked example.
    expect(db).toBe("{{project}}");
    expect(readFileSync(join(here, "reference/.env.example"), "utf8"))
      .toBe(`DATABASE_URL=postgres://${user}:${password}@localhost:5432/${db}\n`);
    // `{{project}}` is the only placeholder root config may use (TN-26-012 §10).
    for (const file of ["reference/docker-compose.yml", "reference/.env.example"]) {
      const placeholders = [...readFileSync(join(here, file), "utf8").matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      expect(new Set(placeholders), file).toEqual(new Set(["project"]));
    }
  });

  test("the root manifest gets db:up, db:migrate over every context, and check:db folded into check", () => {
    const pkg = packageFor(PACKS, packsDir);
    expect(pkg.scripts).toMatchObject({
      "db:up": "docker compose up -d",
      "db:migrate": "bun scripts/db-migrate.ts",
      "check:db": "bun scripts/check-db.ts",
    });
    expect(pkg.scripts!["check"]).toMatch(/run check:db$/);
    expect(shippedFiles(PACKS, packsDir).map((f) => f.path)).toEqual(expect.arrayContaining(["scripts/check-db.ts", "scripts/db-migrate.ts"]));
  });

  test("the shipped scripts import nothing but Node built-ins and each other", () => {
    for (const script of ["check-db.ts", "db-migrate.ts"]) {
      const source = readFileSync(join(here, "scripts", script), "utf8");
      const specifiers = [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]!);
      expect(specifiers.length, script).toBeGreaterThan(0);
      expect(specifiers.every((s) => s.startsWith("node:") || s === "./check-db.ts"), script).toBe(true);
    }
  });

  test("the local .env is ignored; its committed template is not", () => {
    const rules = projectIgnoreRules(PACKS, packsDir);
    expect(rules).toContain("/.env");
    expect(rules.some((rule) => rule.includes("example"))).toBe(false);
  });
});
