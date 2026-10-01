// End to end, under `bun test`: a context with the generated Drizzle files, a
// migration from the generator, builder-written stores and a mapper, and a
// test-writer's store test running a shared conformance suite through the
// generated test support (ADR 2026-064).
//
//   · red's skip path runs everywhere Bun is installed: no container runtime
//     is needed, and the skip is logged with its reason;
//   · without a container runtime and without the skip variable, the store
//     tests FAIL, never pass silently;
//   · with a container runtime, Testcontainers starts Postgres, the
//     migrations apply and the conformance suite passes against it.
//
// Whichever of the last two cannot run here is skipped with the reason logged.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  drizzleStoreTests, probeContainerRuntime, STORE_TEST_ENV, storeTestDecision, storeTestEnv, storeTestPhaseDecision, storeTestPolicy,
  type ContainerRuntimeProbe,
} from "./scripts/container-runtime.ts";
import { APP_DATABASE_ENV, dockerCli, startAppDatabase } from "./scripts/app-database.ts";
import {
  DEFAULT_PREFLIGHT_DEPS, PREFLIGHT_LABEL_KEY, PREFLIGHT_LABEL_VALUE, preflightTargets, preflightTestcontainers, testcontainersResolution,
} from "./scripts/testcontainers-preflight.ts";
import { combineDecisions, withPreparedServices } from "../ts/scripts/phase-policy.ts";
import { emitDrizzlePersistence, POSTGRES_IMAGE, RED_PHASE_TOKEN, STORE_TESTS_PHASE_ENV, STORE_TESTS_SKIP_ENV } from "./scripts/emit.ts";
import { generateMigrations } from "./scripts/generate-migrations.ts";
import { APPLICATION_CONTRACTS, contextWorkspace, DOMAIN_CONTRACTS, EXAMPLE_SCHEMA, exampleFacts, RESULT_SOURCE, SOURCE_ROOT } from "./testdata/example-project.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..", "..");
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" });
const bun = bunVersion.status === 0 ? undefined : "bun is not installed, so the generated test support cannot run here";
const runtime: ContainerRuntimeProbe = probeContainerRuntime();
if (bun !== undefined) console.warn(`store-integration: skipping every Bun run: ${bun}`);
if (!runtime.available) console.warn(`store-integration: skipping the real Postgres run: ${runtime.reason}`);
else console.warn("store-integration: skipping the no-runtime failure check: a container runtime is answering");

const lines = (...text: string[]): string => text.join("\n") + "\n";

const CONTRACTS = Object.fromEntries(Object.entries(APPLICATION_CONTRACTS).filter(([path]) =>
  /create-project|list-projects/.test(path)));

const valueObject = (name: string, test: string, error: string, generate: boolean): string => lines(
  'import type { Result } from "../shared/result.ts";',
  `import type * as Contract from "./${name === "ProjectId" ? "project-id" : "project-name"}.contract.ts";`,
  "",
  `class ${name}Impl implements Contract.${name} {`,
  `  declare readonly __brand: "${name}";`,
  "  private constructor(readonly value: string) {}",
  ...(generate ? [`  static generate(): ${name} { return new ${name}Impl(crypto.randomUUID()); }`] : []),
  `  static parse(raw: unknown): Result<${name}> {`,
  `    return typeof raw === "string" && ${test} ? { ok: true, value: new ${name}Impl(raw) } : { ok: false, error: "${error}" };`,
  "  }",
  `  equals(other: ${name}): boolean { return this.value === other.value; }`,
  "  toJSON(): string { return this.value; }",
  "}",
  "",
  `export type ${name} = Contract.${name};`,
  `export const ${name}: Contract.${name}Factory = ${name}Impl;`,
);

/** The builder's and test-writer's half of the context, as they would write it. */
const AUTHORED: Record<string, string> = {
  "domain/shared/result.ts": RESULT_SOURCE,
  "domain/projects/project-id.ts": valueObject("ProjectId", "/^[0-9a-f-]{36}$/.test(raw)", "Invalid project id", true),
  "domain/projects/project-name.ts": valueObject("ProjectName", 'raw.trim() !== ""', "Invalid project name", false),
  "domain/projects/project.ts": lines(
    'import type * as Contract from "./project.contract.ts";',
    'import type { ProjectId } from "./project-id.contract.ts";',
    'import type { ProjectName } from "./project-name.contract.ts";',
    "",
    "class ProjectImpl implements Contract.Project {",
    '  declare readonly __brand: "Project";',
    "  constructor(readonly id: ProjectId, readonly name: ProjectName) {}",
    "  equals(other: Project): boolean { return this.id.equals(other.id); }",
    "  toJSON(): { readonly id: string; readonly name: string } { return { id: this.id.value, name: this.name.value }; }",
    "}",
    "",
    "export type Project = Contract.Project;",
    "export const Project: Contract.ProjectFactory = ProjectImpl;",
  ),
  "domain/index.ts": lines(
    'export type { Result } from "./shared/result.ts";',
    'export { Project } from "./projects/project.ts";',
    'export { ProjectId } from "./projects/project-id.ts";',
    'export { ProjectName } from "./projects/project-name.ts";',
  ),
  "application/index.ts": lines(
    'export type { CreateProjectStore } from "./projects/create-project/create-project.contract.ts";',
    'export type { ListProjectsStore } from "./projects/list-projects/list-projects.contract.ts";',
  ),
  "application/projects/list-projects/list-projects.store.test-support.ts": lines(
    'import { expect, test } from "bun:test";',
    'import type { ListProjectsStore } from "@example/project-management/application";',
    'import { Project, ProjectId, ProjectName } from "@example/project-management/domain";',
    "",
    "const named = (name: string): Project => {",
    "  const parsed = ProjectName.parse(name);",
    "  if (!parsed.ok) throw new Error(parsed.error);",
    "  return new Project(ProjectId.generate(), parsed.value);",
    "};",
    "",
    "export function listProjectsStoreConformance(make: () => ListProjectsStore, seed: (project: Project) => Promise<void>): void {",
    '  test("findAll returns every saved project as a domain object", async () => {',
    '    const saved = [named("Beta"), named("Alpha")];',
    "    for (const project of saved) await seed(project);",
    "    const found = await make().findAll();",
    "    expect(found.map((p) => p.toJSON())).toEqual(saved.map((p) => p.toJSON()).sort((a, b) => a.name.localeCompare(b.name)));",
    "    expect(found.every((p, i) => p.equals([...saved].sort((a, b) => a.name.value.localeCompare(b.name.value))[i]!))).toBe(true);",
    "  });",
    "",
    '  test("findAll is empty when nothing was saved (every test starts from empty tables)", async () => {',
    "    expect(await make().findAll()).toEqual([]);",
    "  });",
    "}",
  ),
  "adapters/out/drizzle/schema/projects.ts": EXAMPLE_SCHEMA["projects.ts"]!,
  "adapters/out/drizzle/projects/project.mapper.ts": lines(
    'import { Project, ProjectId, ProjectName } from "@example/project-management/domain";',
    'import type { projects } from "../schema/projects.ts";',
    "",
    "export function toProject(row: typeof projects.$inferSelect): Project {",
    "  const id = ProjectId.parse(row.id);",
    "  const name = ProjectName.parse(row.name);",
    "  if (!id.ok || !name.ok) throw new Error(`corrupt projects row ${row.id}`);",
    "  return new Project(id.value, name.value);",
    "}",
  ),
  "adapters/out/drizzle/projects/create-project.store.ts": lines(
    'import type { CreateProjectStore } from "@example/project-management/application";',
    'import type { Project } from "@example/project-management/domain";',
    'import type { DrizzleDatabase } from "../drizzle-database.ts";',
    'import { projects } from "../schema/projects.ts";',
    "",
    "export class DrizzleCreateProjectStore implements CreateProjectStore {",
    "  constructor(private readonly db: DrizzleDatabase) {}",
    "",
    "  async save(project: Project): Promise<void> {",
    "    await this.db.insert(projects).values({ id: project.id.value, name: project.name.value });",
    "  }",
    "}",
  ),
  "adapters/out/drizzle/projects/list-projects.store.ts": lines(
    'import type { ListProjectsStore } from "@example/project-management/application";',
    'import type { Project } from "@example/project-management/domain";',
    'import type { DrizzleDatabase } from "../drizzle-database.ts";',
    'import { projects } from "../schema/projects.ts";',
    'import { toProject } from "./project.mapper.ts";',
    "",
    "export class DrizzleListProjectsStore implements ListProjectsStore {",
    "  constructor(private readonly db: DrizzleDatabase) {}",
    "",
    "  async findAll(): Promise<Project[]> {",
    "    const rows = await this.db.select().from(projects).orderBy(projects.name);",
    "    return rows.map(toProject);",
    "  }",
    "}",
  ),
  "adapters/out/drizzle/projects/list-projects.store.test.ts": lines(
    'import { listProjectsStoreConformance } from "../../../../application/projects/list-projects/list-projects.store.test-support.ts";',
    'import { describeDrizzleStore } from "../drizzle-test-database.test-support.ts";',
    'import { DrizzleCreateProjectStore } from "./create-project.store.ts";',
    'import { DrizzleListProjectsStore } from "./list-projects.store.ts";',
    "",
    'describeDrizzleStore("DrizzleListProjectsStore", (db) => {',
    "  listProjectsStoreConformance(",
    "    () => new DrizzleListProjectsStore(db()),",
    "    (project) => new DrizzleCreateProjectStore(db()).save(project),",
    "  );",
    "});",
  ),
};

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "drizzle-store-"));
  temporary.push(dir);
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  symlinkSync(join(agentRoot, "node_modules"), join(dir, "node_modules"), "dir");
  write("package.json", '{ "private": true, "type": "module", "workspaces": ["contexts/*"] }\n');
  write("tsconfig.json", JSON.stringify({
    compilerOptions: { paths: { "@example/project-management/*": [`./${SOURCE_ROOT}/*/index.ts`] } },
  }));
  const domain = Object.fromEntries(Object.entries(DOMAIN_CONTRACTS).filter(([path]) => path.startsWith("domain/projects/")));
  const contracts = { ...CONTRACTS, ...domain };
  for (const [path, source] of Object.entries({ ...contracts, ...AUTHORED })) write(`${SOURCE_ROOT}/${path}`, source);
  const generated = emitDrizzlePersistence(exampleFacts("red", [contextWorkspace("project-management", contracts)]));
  for (const file of generated) write(file.path, file.content);
  generateMigrations(dir);
}, 60_000);

/** Run the store tests with exactly `env` (plus PATH/HOME for bun and Docker). */
function bunTest(env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of STORE_TEST_ENV) delete base[name];
  const run = spawnSync("bun", ["test", "./contexts"], { cwd: dir, env: { ...base, ...env }, encoding: "utf8", timeout: 280_000 });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

describe("the generated store-test support under bun test", () => {
  test.skipIf(bun !== undefined)("red's skip: every store test skips with the reason logged, and the run passes without Docker", () => {
    const decision = storeTestDecision("red", ["x.store.test.ts"], { available: false, reason: "no container runtime found" });
    if (decision.action !== "skip") throw new Error("expected a skip decision");
    const run = bunTest(storeTestEnv({}, decision));
    expect(run.output).toContain(`store tests skipped: DrizzleListProjectsStore: ${decision.reason}`);
    expect(run.output).toMatch(/\b0 pass\b/);
    expect(run.output).toMatch(/\b2 skip\b/);
    expect(run.output).toMatch(/\b0 fail\b/);
    expect(run.status, run.output).toBe(0);
  }, 120_000);

  test.skipIf(bun !== undefined)("a leaked skip variable without the red token fails the store tests, with or without Docker", () => {
    const run = bunTest({ [STORE_TESTS_SKIP_ENV]: "left over from an earlier red run" });
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toMatch(/\b0 pass\b/);
    expect(run.output).toMatch(/\b1 fail\b/);
    expect(run.output).not.toContain("store tests skipped");
    expect(run.output).toContain("BOUNDED_STORE_TESTS_SKIP is set without BOUNDED_STORE_TESTS_PHASE=red");
  }, 120_000);

  test.skipIf(bun !== undefined)("green's environment, built from its decision, drops a leaked skip and red token: no silent pass", () => {
    const leaked = { [STORE_TESTS_SKIP_ENV]: "stale", [STORE_TESTS_PHASE_ENV]: RED_PHASE_TOKEN };
    const decision = storeTestDecision("green", ["x.store.test.ts"], runtime);
    const env = storeTestEnv(leaked, decision);
    expect(env).toEqual({});
    if (decision.action === "refuse") return; // green never runs: nothing can pass
    const run = bunTest(env);
    expect(run.output).not.toContain("store tests skipped");
    expect(run.output).toMatch(/\b2 pass\b/);
  }, 300_000);

  test.skipIf(bun !== undefined || runtime.available)("without a container runtime and no skip, the store tests fail, never pass", () => {
    const run = bunTest({});
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toMatch(/\b0 pass\b/);
    expect(run.output).not.toContain("store tests skipped");
    // It fails for the right reason: Testcontainers found no runtime, not a broken fixture.
    expect(run.output).toMatch(/Could not find a working container runtime strategy/);
  }, 120_000);

  test.skipIf(bun !== undefined || !runtime.available)("with a container runtime: migrations apply and the conformance suite passes on real Postgres", () => {
    const run = bunTest({});
    expect(run.output).toMatch(/\b2 pass\b/);
    expect(run.output).toMatch(/\b0 fail\b/);
    expect(run.status, run.output).toBe(0);
  }, 300_000);
});

// --- the green run's throwaway application database (the app smoke tests) -----------

const dockerCliMissing = spawnSync("docker", ["--version"]).status === 0 ? undefined : "the docker CLI is not on PATH";
const appDatabaseSkip = bun ?? (!runtime.available ? runtime.reason : dockerCliMissing);
if (appDatabaseSkip !== undefined) console.warn(`store-integration: skipping the throwaway application database: ${appDatabaseSkip}`);

describe.skipIf(appDatabaseSkip !== undefined)("the green run's throwaway application database", () => {
  test("starts, applies every context's migrations, answers through its URL, and is gone after release", { timeout: 900_000 }, async () => {
    const endpoint = runtime.available ? runtime.endpoint : "";
    const service = await startAppDatabase(dir, endpoint);
    const name = /\((bounded-green-db-[0-9a-f]+)\)/.exec(service.description)?.[1] ?? "";
    try {
      expect(service.env[APP_DATABASE_ENV]).toMatch(/^postgres:\/\/postgres:postgres@127\.0\.0\.1:\d+\/app$/);
      const tables = await dockerCli(["exec", name, "psql", "-U", "postgres", "-d", "app", "-tAc",
        "select count(*) from information_schema.tables where table_schema = 'project_management'"], endpoint);
      expect(Number(tables.stdout.trim())).toBeGreaterThan(0);
    } finally {
      service.release();
    }
    expect((await dockerCli(["ps", "--all", "--quiet", "--filter", `name=${name}`], endpoint)).stdout.trim()).toBe("");
  });
});

// --- green's Testcontainers preflight, on a real runtime ------------------------

const preflightSkip = bun ?? (!runtime.available ? runtime.reason : dockerCliMissing);
if (preflightSkip !== undefined) console.warn(`store-integration: skipping the Testcontainers preflight: ${preflightSkip}`);

describe.skipIf(preflightSkip !== undefined)("green's Testcontainers preflight on a real runtime", () => {
  const endpoint = runtime.available ? runtime.endpoint : "";
  const leftovers = async (): Promise<string> =>
    (await dockerCli(["ps", "--all", "--quiet", "--filter", `label=${PREFLIGHT_LABEL_KEY}=${PREFLIGHT_LABEL_VALUE}`], endpoint)).stdout.trim();
  /** A Docker config naming a credential helper nobody has installed. */
  const brokenDockerConfig = (): string => {
    const config = mkdtempSync(join(tmpdir(), "docker-config-"));
    temporary.push(config);
    writeFileSync(join(config, "config.json"), JSON.stringify({ credsStore: "bounded-absent-helper" }));
    return config;
  };
  // Testcontainers asks the credential helper only when it must pull, and the
  // pinned image is on this runtime after the first case. An image reference
  // no runtime holds forces the pull, so the helper is asked first, exactly as
  // on a machine meeting the pinned image for the first time.
  const UNCACHED = "postgres:0.0.0-bounded-preflight-absent";

  test("starts and removes one container from the pinned image through the store tests' own Testcontainers", { timeout: 900_000 }, async () => {
    const storeTest = drizzleStoreTests(dir)[0]!;
    const hosts: string[] = [];
    const deps = { ...DEFAULT_PREFLIGHT_DEPS, sweep: (run: string, host: string) => { hosts.push(host); DEFAULT_PREFLIGHT_DEPS.sweep(run, host); } };
    const service = await preflightTestcontainers(dir, storeTest, endpoint, deps);
    expect(service.description).toContain(POSTGRES_IMAGE);
    // The sweep targets the runtime Testcontainers' own client reported using.
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatch(/^(unix|tcp):\/\/./);
    expect(service.env).toEqual({});
    expect(await leftovers()).toBe("");
  });

  test("the composed policy itself: every distinct Testcontainers preflights, then the app database starts, and nothing is left", { timeout: 900_000 }, async () => {
    const decision = storeTestPolicy.decide({ project: dir, phase: "green" });
    if (decision.action !== "run" || decision.prepare === undefined) throw new Error(`expected a run with a prepare, got ${decision.action}`);
    expect(preflightTargets(drizzleStoreTests(dir), (file) => testcontainersResolution(dir, file))).toHaveLength(1);
    const service = await decision.prepare({ set: {}, unset: [] });
    try {
      expect(service.description).toMatch(/^Testcontainers preflight: started and removed .*; started a throwaway /);
      expect(service.env[APP_DATABASE_ENV]).toMatch(/^postgres:\/\//);
    } finally {
      service.release();
    }
    expect(await leftovers()).toBe("");
  });

  test("a credsStore whose helper is not on PATH refuses cleanly, naming the config, the helper and the fix", { timeout: 300_000 }, async () => {
    const deps = { ...DEFAULT_PREFLIGHT_DEPS, env: { ...process.env, DOCKER_CONFIG: brokenDockerConfig() } };
    const refusal = await preflightTestcontainers(dir, drizzleStoreTests(dir)[0]!, endpoint, deps, { image: UNCACHED }).then(
      () => { throw new Error("the preflight passed with a missing credential helper"); },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refusal).toContain("could not start a postgres:0.0.0-bounded-preflight-absent container on this machine (green's preflight, before any test ran)");
    expect(refusal).toContain("docker-credential-bounded-absent-helper");
    expect(refusal).toContain(
      "Remedy: $DOCKER_CONFIG/config.json names credsStore 'bounded-absent-helper' but docker-credential-bounded-absent-helper is not on PATH: remove the line or install the helper.",
    );
    expect(refusal).not.toContain(tmpdir());
    expect(await leftovers()).toBe("");
  });

  test("through the policy and the gate's services: green does not run, and says why", { timeout: 300_000 }, async () => {
    const storeTests = drizzleStoreTests(dir);
    const deps = { ...DEFAULT_PREFLIGHT_DEPS, env: { ...process.env, DOCKER_CONFIG: brokenDockerConfig() } };
    const decision = storeTestPhaseDecision("green", storeTests, () => runtime, false, undefined,
      (probed) => preflightTestcontainers(dir, storeTests[0]!, probed, deps, { image: UNCACHED }));
    let ran = false;
    const prepared = await withPreparedServices(combineDecisions("green", [{ name: storeTestPolicy.name, decision }]), async () => { ran = true; });
    expect(ran).toBe(false);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.reason).toContain("docker-credential-bounded-absent-helper is not on PATH: remove the line or install the helper");
    expect(await leftovers()).toBe("");
  });
});
