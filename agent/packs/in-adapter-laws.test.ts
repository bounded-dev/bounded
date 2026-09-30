// The generated adapter laws, run for real (WI-7 acceptance, TN-26-012 §6).
//
// Every in-adapter emitter (tRPC, MCP and Lambda; this suite sits outside the
// packs because it spans all three) emits into a throwaway copy of the worked example's context — its
// real domain and application code — and `bun test` runs the laws there. They
// must pass against the example, and they must FAIL against an adapter that
// breaks each law: a law that cannot fail proves nothing.
//
// The emitted adapters also type-check under the example's compiler settings,
// against the pinned tRPC and MCP SDK the harness itself installs.
//
// Needs `bun` on PATH; without it the suite logs why and skips.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { EmittedFile } from "./ts/pack.ts";
import { emitLambdaAdapters } from "./ts-lambda/scripts/lambda-emitter.ts";
import { emitMcpAdapters } from "./ts-mcp/scripts/mcp-emitter.ts";
import { EXAMPLE_CONTEXT, EXAMPLE_ROOT, exampleContracts, exampleFacts } from "./example-suite/example-facts.ts";
import { emitTrpcAdapters } from "./ts-trpc/scripts/trpc-emitter.ts";

const agentModules = join(import.meta.dirname, "..", "node_modules");
const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const hasBun = bun.status === 0;
if (!hasBun) console.warn("in-adapter-laws: skipped — `bun` is not on PATH, so the generated laws cannot run here");

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function emitted(): EmittedFile[] {
  const facts = exampleFacts();
  return [...emitTrpcAdapters(facts), ...emitMcpAdapters(facts), ...emitLambdaAdapters(facts)];
}

/** A throwaway project: the example context's domain and application, the
 *  emitted in adapters, and just enough node_modules to resolve them. */
function fixture(files: readonly EmittedFile[]): string {
  const dir = mkdtempSync(join(tmpdir(), "in-adapter-laws-"));
  dirs.push(dir);
  const context = join(dir, EXAMPLE_CONTEXT);
  for (const layer of ["domain", "application"]) {
    cpSync(join(EXAMPLE_ROOT, EXAMPLE_CONTEXT, "src", layer), join(context, "src", layer), { recursive: true });
  }
  cpSync(join(EXAMPLE_ROOT, EXAMPLE_CONTEXT, "package.json"), join(context, "package.json"));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.content);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }));
  mkdirSync(join(dir, "node_modules", "@example"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "@trpc"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "@modelcontextprotocol"), { recursive: true });
  symlinkSync(join(agentModules, "@modelcontextprotocol", "sdk"), join(dir, "node_modules", "@modelcontextprotocol", "sdk"), "dir");
  symlinkSync(context, join(dir, "node_modules", "@example", "project-management"), "dir");
  symlinkSync(join(agentModules, "zod"), join(dir, "node_modules", "zod"), "dir");
  symlinkSync(join(agentModules, "@trpc", "server"), join(dir, "node_modules", "@trpc", "server"), "dir");
  return dir;
}

function bunTest(dir: string): { status: number | null; output: string } {
  const run = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

/** Replace exactly one occurrence of `from` in the emitted file at `path`. */
function mutate(files: EmittedFile[], path: string, from: string, to: string): EmittedFile[] {
  return files.map((file) => {
    if (!file.path.endsWith(path)) return file;
    expect(file.content.split(from).length, `${path} contains '${from}' once`).toBe(2);
    return { ...file, content: file.content.replace(from, to) };
  });
}

describe.skipIf(!hasBun)("the generated adapter laws under bun test", () => {
  test("pass against the worked example", () => {
    const { status, output } = bunTest(fixture(emitted()));
    expect(output).toMatch(/\b0 fail\b/);
    // tRPC: 4 laws per input feature + 1 for the Result, 2 per input-less one
    // (5 + 4 + 2 + 2); MCP: the registration law too (5 + 3); Lambda: 2.
    expect(output).toMatch(/\b23 pass\b/);
    expect(status, output).toBe(0);
  }, 60_000);

  test("pass for every return shape the example does not show", () => {
    // Re-type the example's in ports so every branch of the mapping is
    // emitted and exercised by all three technologies. The handlers no longer
    // match their ports, which only the type checker would notice: the laws
    // exercise the adapters with fake in ports.
    const shapes: Record<string, readonly [string, string]> = {
      "create-note": ["Promise<Result<Note>>", "Promise<void>"],
      "list-notes": ["Promise<Note[]>", "Promise<Result<Note[]>>"],
      "create-project": ["Promise<Project>", "Promise<Result<void>>"],
      "list-projects": ["Promise<Project[]>", "Promise<Project>"],
      "export-projects": ["Promise<void>", "Promise<Result<Project>>"],
    };
    const contracts = exampleContracts().map((contract) => {
      const feature = Object.keys(shapes).find((f) => contract.path.endsWith(`/${f}.contract.ts`));
      if (feature === undefined) return contract;
      const [from, to] = shapes[feature]!;
      const source = contract.source
        .replace(from, to)
        .replace(/@exposedVia [a-z ]+/, "@exposedVia trpc mcp lambda")
        // Result joins the domain import only where the new shape uses it: the
        // parser refuses an import a contract does not use.
        .replace(/import type \{ ([^}]+) \} from/, (_, names: string) =>
          `import type { ${[...new Set([...names.split(", "), ...(to.includes("Result<") ? ["Result"] : [])])].sort().join(", ")} } from`);
      return { ...contract, source };
    });
    const facts = exampleFacts({ contracts });
    const files = [...emitTrpcAdapters(facts), ...emitMcpAdapters(facts), ...emitLambdaAdapters(facts)];
    expect(files.filter((f) => f.path.endsWith(".laws.test.ts"))).toHaveLength(15);
    const { status, output } = bunTest(fixture(files));
    expect(output).toMatch(/\b0 fail\b/);
    expect(status, output).toBe(0);
  }, 60_000);

  test("skip the domain-invalid law visibly, never vacuously, when the domain refuses nothing", () => {
    // ProjectName that accepts any string: no candidate is domain-invalid.
    const dir = fixture(emitted());
    const name = join(dir, EXAMPLE_CONTEXT, "src/domain/projects/project-name.ts");
    writeFileSync(name, readFileSync(name, "utf8").replace('z.string().trim().min(1, "Project name is required")', "z.string()"));
    const { status, output } = bunTest(dir);
    expect(status, output).toBe(0);
    expect(output).toMatch(/adapter law skipped: CreateProjectCommand\.parse refuses no candidate wire value/);
    // The tRPC procedure's and the MCP tool's domain-invalid laws are skipped, and counted as such.
    expect(output).toMatch(/\b2 skip\b/);
    expect(output).toMatch(/\b0 fail\b/);
  }, 60_000);

  test("fail against adapters that break each law", () => {
    let files = emitted();
    // tRPC: invalid input reaches the in port.
    files = mutate(files, "notes/create-note.procedure.ts", "    if (!command.ok) return command;\n", "");
    // tRPC: a domain object escapes instead of plain data.
    files = mutate(files, "projects/list-projects.procedure.ts", ".map((project) => project.toJSON())", "");
    // MCP: invalid input reaches the in port.
    files = mutate(files, "projects/create-project.tool.ts",
      '      if (!command.ok) return { isError: true, content: [{ type: "text", text: command.error }] };\n', "");
    // Lambda: execute is called twice.
    files = mutate(files, "projects/export-projects.lambda.ts", "  await exportProjects.execute();\n",
      "  await exportProjects.execute();\n  await exportProjects.execute();\n");
    const { status, output } = bunTest(fixture(files));
    expect(status).not.toBe(0);
    for (const law of [
      /\(fail\) createNoteProcedure — adapter laws > returns the command's failure for a domain-invalid input/,
      /\(fail\) listProjectsProcedure — adapter laws > returns plain toJSON data/,
      /\(fail\) registerCreateProjectTool — adapter laws > refuses a wire-invalid input/,
      /\(fail\) createExportProjectsLambda — adapter laws > calls execute exactly once/,
    ]) expect(output).toMatch(law);
  }, 60_000);
});

describe("the emitted tRPC, MCP and Lambda adapters type-check", () => {
  test("under the example's compiler settings", () => {
    const files = emitted().filter((f) => !f.path.endsWith(".laws.test.ts"));
    const dir = fixture(files);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        lib: ["ESNext", "DOM"], target: "ESNext", module: "Preserve", moduleDetection: "force", types: [],
        moduleResolution: "bundler", allowImportingTsExtensions: true, verbatimModuleSyntax: true, noEmit: true,
        strict: true, skipLibCheck: true, noUncheckedIndexedAccess: true, noImplicitOverride: true,
      },
      include: [`${EXAMPLE_CONTEXT}/src`],
    }));
    const tsc = spawnSync(process.execPath, [join(agentModules, "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
      cwd: dir, encoding: "utf8",
    });
    expect(`${tsc.stdout}${tsc.stderr}`).toBe("");
    expect(tsc.status).toBe(0);
  }, 60_000);
});
