// The developer-stage pipeline, end to end, on a real hexagonal Bun monorepo
// (WI-8's acceptance test): `bounded init` with the hexagonal, tRPC and web
// packs, then the notebook design (one context, a command and a query, a web
// app) through every gate with real bun and real tsc, each gate run through
// the project's own copied harness exactly as a role would run it:
//
//   design-gate    scaffold writes the emitted files, creates the context and
//                  app workspaces, regenerates the lockfile and installs
//   handoff        the frozen design is published from a real commit
//   red-gate       valid while a half-written handler sits in the live tree:
//                  the shadow's workspace links point into the shadow
//   green-gate     binds to the red's test files; editing a test voids it
//   sign-off, deliver (the project's own `bun run check` included),
//   mutation-score (advisory)
//
// Skipped, with the reason logged, only when bun is not on PATH. It needs the
// packages the packs pin from bun's cache or the registry, as `bounded init`
// itself does.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readGuardLog } from "../../../src/guard-log.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { INSTALLATION_RELATIVE } from "../../../src/setup-state.ts";
import { probeContainerRuntime } from "../../ts-drizzle-postgres/scripts/container-runtime.ts";
import { runDesignGate } from "./design-gate.ts";
import { runArtifactGenerators } from "./generate-artifacts.ts";
import { runGreenGate } from "./green-gate.ts";
import { writeProjectPackage } from "./project-package.ts";
import { runRedGate } from "./red-gate.ts";
import { applyInit, planInit } from "../../../src/project-init.ts";
import { runRecordDesignReview } from "./design-review.ts";
import { CONTEXT_SRC, placeStage } from "./pipeline-fixture.test-support.ts";
import { testFilesHash } from "./red-gate.ts";

const AGENT = join(import.meta.dirname, "..", "..", "..");
const HAS_BUN = spawnSync("bun", ["--version"]).status === 0;
if (!HAS_BUN) console.warn("pipeline.test.ts: skipping the end-to-end pipeline — `bun` is not on PATH");

const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

interface Gate {
  readonly status: number | null;
  readonly out: string;
}

/** Run one gate through the project's own copied harness, as a role does. */
function gate(dir: string, name: string, ...args: string[]): Gate {
  const r = spawnSync("bash", [join(dir, ".bounded/harness/scripts/bounded"), "gates", name, ...args, dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, BOUNDED_TICKET: "1" },
    timeout: 240_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A freshly initialised project with the harness's own dependencies linked
 *  where the project-local harness expects them (setup installs them there). */
async function initialised(packs: readonly string[]): Promise<{ dir: string; scope: string }> {
  const dir = join(mkdtempSync(join(tmpdir(), "bounded-e2e-")), "notebook");
  temporary.push(join(dir, ".."));
  const plan = await planInit(dir, "claude-code", packs);
  await applyInit(dir, "claude-code", packs, plan.digest);
  symlinkSync(join(AGENT, "node_modules"), join(dir, ".bounded/harness/node_modules"), "dir");
  const install = spawnSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: dir, encoding: "utf8" });
  expect(install.status, install.stderr).toBe(0);
  const name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string }).name;
  return { dir, scope: `@${name}` };
}

describe.skipIf(!HAS_BUN)("the pipeline on a hexagonal Bun monorepo", () => {
  test("design → handoff → red (isolated) → green (bound) → sign-off → deliver → mutation", { timeout: 600_000 }, async () => {
    const { dir, scope } = await initialised(["ts-hexagonal", "ts-trpc", "ts-web"]);

    // --- design: the architect's TN and contracts, challenged, frozen ---
    placeStage(dir, "design", scope);
    const priorTicket = process.env["BOUNDED_TICKET"];
    process.env["BOUNDED_TICKET"] = "1";
    try {
      expect(runRecordDesignReview(dir, []).code).toBe(0);
    } finally {
      if (priorTicket === undefined) delete process.env["BOUNDED_TICKET"];
      else process.env["BOUNDED_TICKET"] = priorTicket;
    }
    const design = gate(dir, "design-gate");
    expect(design.status, design.out).toBe(0);
    expect(design.out).toContain("workspaces synced: apps/web, contexts/notebook");
    expect(design.out).toContain("ran bun install --frozen-lockfile --ignore-scripts");
    // The workspaces exist, are linked, and the design's skeletons throw.
    expect(existsSync(join(dir, "contexts/notebook/package.json"))).toBe(true);
    expect(realpathSync(join(dir, `apps/web/node_modules/${scope}/notebook`))).toBe(realpathSync(join(dir, "contexts/notebook")));
    expect(readFileSync(join(dir, CONTEXT_SRC, "application/notes/create-note/create-note.handler.ts"), "utf8"))
      .toContain('throw new NotImplementedError("CreateNoteHandler.execute")');
    expect(existsSync(join(dir, ".bounded/tickets/1/contract-checksums.json"))).toBe(true);

    // --- handoff: the frozen design, published from a real commit ---
    git(dir, "init", "-q");
    git(dir, "-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", "-A");
    git(dir, "-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "design");
    const handoff = gate(dir, "handoff-publish", "--producer", "1");
    expect(handoff.status, handoff.out).toBe(0);

    // --- red: the test-writer's suite, with the builder working in parallel:
    // the domain done, the create-note handler half written (it never saves) ---
    placeStage(dir, "tests", scope);
    placeStage(dir, "build", scope);
    placeStage(dir, "half", scope);
    const red = gate(dir, "red-gate");
    expect(red.status, red.out).toBe(0);
    expect(red.out).toMatch(/red-gate: OK — \d+ NotImplemented failures, 0 passed, \d+ total, typecheck clean/);
    // The shadow's workspace links resolve into the shadow, never the live tree.
    const shadow = join(dir, ".bounded/shadow-red");
    expect(realpathSync(join(shadow, `apps/web/node_modules/${scope}/notebook`))).toBe(realpathSync(join(shadow, "contexts/notebook")));
    expect(readFileSync(join(shadow, CONTEXT_SRC, "application/notes/create-note/create-note.handler.ts"), "utf8"))
      .toContain("NotImplementedError");
    // Against the live tree the half-written handler fails for the wrong reason.
    const live = spawnSync("bun", ["test", `${CONTEXT_SRC}/application/notes/create-note/create-note.test.ts`], { cwd: dir, encoding: "utf8" });
    expect(`${live.stdout}${live.stderr}`).toMatch(/Expected length: 1|toHaveLength/);
    const redEvent = readGuardLog(dir).filter((e) => e.guard === "red-gate").at(-1);
    expect(redEvent).toMatchObject({ verdict: "pass", detail: { testFilesHash: testFilesHash(dir) } });

    // --- green: the builder finishes; green binds to the red's tests ---
    placeStage(dir, "build", scope);
    const green = gate(dir, "green-gate");
    expect(green.status, green.out).toBe(0);
    expect(green.out).toMatch(/green-gate: OK — \d+ passed, \d+ total, typecheck clean/);
    const test = join(dir, CONTEXT_SRC, "domain/notes/note.test.ts");
    const original = readFileSync(test, "utf8");
    writeFileSync(test, `${original}// edited after the red\n`);
    const voided = gate(dir, "green-gate");
    expect(voided.status).toBe(1);
    expect(voided.out).toContain("a test-side file has changed since the red-gate pass that covers it");
    writeFileSync(test, original);
    expect(gate(dir, "green-gate").status).toBe(0);

    // --- sign-off and delivery ---
    const signOff = gate(dir, "sign-off", "--findings", "[]");
    expect(signOff.status, signOff.out).toBe(0);
    const deliver = gate(dir, "deliver");
    expect(deliver.status, deliver.out).toBe(0);
    expect(deliver.out).toContain(`removed ${CONTEXT_SRC}/domain/shared/errors.ts`);
    expect(deliver.out).toMatch(/deliver: check — bun run check passed/);
    expect(deliver.out).toContain("surface-check: OK");
    expect(existsSync(join(dir, CONTEXT_SRC, "domain/shared/errors.ts"))).toBe(false);
    expect(existsSync(shadow)).toBe(false);
    const again = gate(dir, "deliver");
    expect(again.out).toContain("deliver: OK — 0 steps applied");

    // --- mutation score: advisory, over the delivered source ---
    const mutation = gate(dir, "mutation-score", "--max-mutants", "6");
    expect(mutation.status, mutation.out).toBe(0);
    expect(mutation.out).toMatch(/mutation-score: .*killed/i);
  });
});

// --- persistence (ADR LEG-2026-064) ----------------------------------------------------
//
// The same notebook with ts-drizzle-postgres composed: every store also has a
// Drizzle implementation, tested against real Postgres through Testcontainers.
// Red never needs a container runtime: without one it skips the store tests,
// in the test process only, and says why. Green refuses clearly when store
// tests exist and no runtime answers; with one, it runs them.
//
// The project's config is generated exactly as `bounded init` generates it
// (project-package.ts), and the gates run in this process.

async function withTicket<T>(body: () => Promise<T>): Promise<T> {
  const prior = process.env["BOUNDED_TICKET"];
  process.env["BOUNDED_TICKET"] = "1";
  try {
    return await body();
  } finally {
    if (prior === undefined) delete process.env["BOUNDED_TICKET"];
    else process.env["BOUNDED_TICKET"] = prior;
  }
}

/** A project whose config the packs generated (manifests, tsconfig, bun.lock,
 *  root config, shipped files), installed from its lockfile. */
function generatedProject(packs: readonly string[]): { dir: string; scope: string } {
  const dir = join(mkdtempSync(join(tmpdir(), "bounded-e2e-pg-")), "notebook");
  temporary.push(join(dir, ".."));
  mkdirSync(dir, { recursive: true });
  writeProjectPacks(dir, packs);
  writeProjectPackage(dir, AGENT, "notebook");
  writeFileSync(join(dir, INSTALLATION_RELATIVE), "{}\n");
  // The project-local harness the setup commands are read from, as init copies it.
  symlinkSync(AGENT, join(dir, ".bounded/harness"), "dir");
  // Ticket-numbered design notes, as init sets them up.
  mkdirSync(join(dir, "docs/tn"), { recursive: true });
  writeFileSync(join(dir, "docs/tn/README.md"), "# Technical notes\n");
  const install = spawnSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: dir, encoding: "utf8" });
  expect(install.status, install.stderr).toBe(0);
  return { dir, scope: "@notebook" };
}

/** The persisting project once green passed on it with a container engine. */
let greenPersisting: string | undefined;
const ENGINE = probeContainerRuntime();

describe.skipIf(!HAS_BUN)("the pipeline with Postgres persistence", () => {
  test("red skips the store tests without a container runtime; green refuses without one and runs them with one", { timeout: 600_000 }, async () => {
    const { dir, scope } = generatedProject(["ts", "ts-hexagonal", "ts-trpc", "ts-web", "ts-drizzle-postgres"]);
    await withTicket(async () => {
      placeStage(dir, "design", scope);
      const review = runRecordDesignReview(dir, []);
      expect(review.code, review.lines.join("\n")).toBe(0);
      const design = await runDesignGate(dir);
      expect(design.code, design.lines.join("\n")).toBe(0);
      expect(existsSync(join(dir, "contexts/notebook/src/adapters/out/drizzle/notes/create-note.store.ts"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "contexts/notebook/package.json"), "utf8"))).toMatchObject({
        exports: { "./adapters/drizzle": "./src/adapters/out/drizzle/index.ts" },
        dependencies: { "drizzle-orm": "0.45.3" },
      });

      placeStage(dir, "tests", scope);
      placeStage(dir, "tests-drizzle", scope);
      const runtime = probeContainerRuntime();
      const red = await runRedGate(dir);
      expect(red.code, red.lines.join("\n")).toBe(0);
      if (!runtime.available) {
        expect(red.lines.join("\n")).toMatch(/red-gate: skipped — 2 Drizzle store test file\(s\) skipped at red: /);
        expect(red.lines.join("\n")).toMatch(/red-gate: \d+ skipped tests? not counted/);
      }
      // The skip lives in the test process only: nothing leaked into this one.
      expect(process.env["BOUNDED_STORE_TESTS_SKIP"]).toBeUndefined();

      placeStage(dir, "build", scope);
      placeStage(dir, "build-drizzle", scope);
      const artifacts = runArtifactGenerators(dir);
      expect(artifacts.code, artifacts.lines.join("\n")).toBe(0);
      const migrations = join(dir, "contexts/notebook/src/adapters/out/drizzle/migrations");
      expect(readdirSync(migrations).some((f) => f.endsWith(".sql"))).toBe(true);

      const green = await runGreenGate(dir);
      if (runtime.available) {
        expect(green.code, green.lines.join("\n")).toBe(0);
        greenPersisting = dir;
      } else {
        expect(green.code).toBe(1);
        expect(green.lines.join("\n")).toMatch(/green needs a container runtime: 2 Drizzle store test file\(s\) run against real Postgres/);
        expect(green.lines).toContain("green-gate: route → orchestrator");
        expect(green.detail).toMatchObject({ reason: "test-policy" });
      }
    });
  });

  // Issue #52 (ADR LEG-2026-072): the project's own check needs a container
  // engine and nothing else. The app smoke tests start their own migrated
  // Postgres, so neither a `.env` file nor an inherited DATABASE_URL (both
  // pointing at a database nobody started) can reach them.
  test.skipIf(!ENGINE.available)("the project's own check passes with a container engine alone: a misleading .env and a dead inherited URL are ignored", { timeout: 600_000 }, () => {
    expect(greenPersisting, "green passed on the persisting project").toBeDefined();
    const dir = greenPersisting!;
    const dead = "postgres://nobody@127.0.0.1:1/none";
    writeFileSync(join(dir, ".env"), `DATABASE_URL=${dead}\n`);
    const contrib = JSON.parse(readFileSync(join(AGENT, "packs/ts/contrib.json"), "utf8")) as { projectCheckCommands: string[][] };
    for (const [command, ...args] of contrib.projectCheckCommands) {
      const run = spawnSync(command!, args, { cwd: dir, encoding: "utf8", env: { ...process.env, DATABASE_URL: dead }, timeout: 540_000 });
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    }
  });
});

