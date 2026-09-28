// The generate_artifacts gate (ADR 2026-055): config drift first, then a
// frozen design, then every composed generator; the architect's tool alone.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { readGuardLog } from "../../../src/guard-log.ts";
import { FORBIDDEN_TOOLS, ROLE_TOOLS } from "../../../src/path-policy.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { cliGates } from "../../../hosts/claude-code/bash-policy.ts";
import { GUARD, runArtifactGenerators } from "./generate-artifacts.ts";
import { manifestRelative } from "./checksum-gate.ts";
import { syncProjectConfig } from "./project-config.ts";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function project(packs: readonly string[], options: { generated?: boolean; frozen?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "generate-artifacts-"));
  temporary.push(dir);
  writeProjectPacks(dir, packs);
  mkdirSync(join(dir, "src/db"), { recursive: true });
  if (options.generated) {
    writeFileSync(join(dir, ".bounded", "installation.json"), "{}\n");
    expect(syncProjectConfig(dir, agentRoot).code).toBe(0);
  }
  if (options.frozen) {
    const manifest = join(dir, manifestRelative(dir));
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, '{ "files": {} }\n');
  }
  return dir;
}

const lastEvent = (dir: string) => readGuardLog(dir).filter((e) => e.guard === GUARD).at(-1);

describe("generate_artifacts", () => {
  test("refuses drifted project config before anything else, routed to the orchestrator", () => {
    const dir = project(["ts", "ts-drizzle-sqlite"], { generated: true, frozen: true });
    writeFileSync(join(dir, "drizzle.config.ts"), 'export default { out: "./src/db" };\n');
    const result = runArtifactGenerators(dir);
    expect(result.code).toBe(1);
    expect(result.detail["step"]).toBe("config-drift");
    expect(result.lines.join("\n")).toContain("drizzle.config.ts: differs from what the composed packs generate");
    expect(result.lines).toContain(`${GUARD}: route → orchestrator`);
    expect(lastEvent(dir)?.verdict).toBe("block");
  });

  test("the generated Drizzle config and the shipped check are part of the drift check", () => {
    const dir = project(["ts", "ts-drizzle-sqlite"], { generated: true, frozen: true });
    writeFileSync(join(dir, "scripts/check-db.ts"), "process.exit(0);\n");
    expect(runArtifactGenerators(dir).lines.join("\n")).toContain("scripts/check-db.ts: differs");
  });

  test("refuses before the design is frozen, routed to the architect", () => {
    const dir = project(["ts", "ts-drizzle-sqlite"]);
    const result = runArtifactGenerators(dir);
    expect(result.code).toBe(1);
    expect(result.summary).toBe("no frozen design");
    expect(result.lines).toContain(`${GUARD}: route → architect`);
    expect(lastEvent(dir)).toMatchObject({ verdict: "block", summary: "no frozen design" });
  });

  test("with no composed generator, passes having run nothing", () => {
    const dir = project(["ts"], { frozen: true });
    const result = runArtifactGenerators(dir);
    expect(result.code).toBe(0);
    expect(result.summary).toBe("no composed pack contributes an artifact generator");
    expect(result.detail["generators"]).toEqual([]);
    expect(lastEvent(dir)?.verdict).toBe("pass");
  });

  test("a failing generator blocks with its name and message", () => {
    const dir = project(["ts", "ts-drizzle-sqlite"], { frozen: true });
    writeFileSync(join(dir, "src/db/schema.ts"), "export {};\n");
    const result = runArtifactGenerators(dir);
    expect(result.code).toBe(1);
    expect(result.summary).toBe("database-migration: project dependencies are missing: drizzle-kit is not installed");
    expect(result.detail["generator"]).toBe("database-migration");
    expect(lastEvent(dir)?.verdict).toBe("block");
  });

  test("runs the composed migration generator once the design is frozen", () => {
    const dir = project(["ts", "ts-drizzle-sqlite"], { generated: true, frozen: true });
    symlinkSync(join(agentRoot, "node_modules"), join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, "src/db/schema.ts"),
      'import { integer, sqliteTable } from "drizzle-orm/sqlite-core";\nexport const t = sqliteTable("t", { id: integer("id").primaryKey() });\n');
    const result = runArtifactGenerators(dir);
    expect(result.code, result.lines.join("\n")).toBe(0);
    expect(result.detail["generators"]).toEqual(["database-migration"]);
    expect(result.lines).toContain("database-migration: migrations generated from the schema");
  }, 60_000);

  test("is the architect's alone, on both hosts", () => {
    for (const role of ["test-writer", "builder", "reviewer"] as const) {
      expect(ROLE_TOOLS[role]).not.toContain("generate_artifacts");
      expect(cliGates(role)).not.toContain("generate_artifacts");
    }
    expect(ROLE_TOOLS.architect).toContain("generate_artifacts");
    expect(FORBIDDEN_TOOLS.architect.has("generate_artifacts")).toBe(false);
  });
});
