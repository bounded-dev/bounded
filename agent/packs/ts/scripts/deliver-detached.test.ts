import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deliveryState } from "../../../src/change-run-status.ts";
import { main, type Output } from "../../../src/gates-cli.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import { generatedFileGlobs } from "../../../src/pack-contrib.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { userCommandViolations } from "../../../test/fixtures/user-steps.ts";
import { SURFACE_SCRIPT } from "./deliver.ts";
import { emitProject, projectFactsOf } from "./project-emitters.ts";
import { writeEmittedFiles } from "./scaffold-project.ts";

// Issue #53's acceptance: delivery of a project whose check outlasts the
// host's command limit completes through repeated gate calls, with no user
// step. Real Bun runs the project's own check (`bun run check`), which here
// sleeps 4 s against a host deadline of 16 s (a 1 s budget per call).

const HAS_BUN = spawnSync("bun", ["--version"]).status === 0;
if (!HAS_BUN) console.warn("deliver-detached.test.ts: skipping — `bun` is not on PATH");

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// --- the fixture: deliver.test.ts's proj(), with a slow check ------------------------

const FIXTURE = join(import.meta.dirname, "testdata", "pipeline");
const SCOPE = "@fixture";
const TS_MORPH_PIN = (JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8")) as {
  dependencies: Record<string, string>;
}).dependencies["ts-morph"]!;

function fixturePart(part: string): Record<string, string> {
  const root = join(FIXTURE, part);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split("\\").join("/").replace(/\.txt$/, "");
        if (!rel.startsWith("contexts/")) continue;
        const text = readFileSync(full, "utf8").replaceAll("{{scope}}", SCOPE);
        out[rel] = text.split("\n").filter((l) => !/^\s*\*\s*@exposedVia\b/.test(l)).join("\n");
      }
    }
  };
  walk(root);
  return out;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  private: true,
  type: "module",
  workspaces: ["contexts/*", "apps/*"],
  scripts: { check: "sleep 4 && echo ran >> ../ran.log && bun run check:surface", "check:surface": SURFACE_SCRIPT },
  devDependencies: { "ts-morph": TS_MORPH_PIN, typescript: "5.9.3" },
}, null, 2) + "\n";

/** A finished run on the monorepo, one directory down so `../ran.log` is ours. */
function proj(): { root: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-deliver-detached-")));
  tmpDirs.push(root);
  const dir = join(root, "project");
  mkdirSync(dir);
  writeProjectPacks(dir, ["ts", "ts-hexagonal"]);
  write(dir, { "package.json": PACKAGE_JSON, ".gitignore": "node_modules/\n", ...fixturePart("design") });
  writeEmittedFiles(dir, emitProject(projectFactsOf(dir, "red"), generatedFileGlobs(dir)));
  write(dir, fixturePart("tests"));
  write(dir, fixturePart("build"));
  write(dir, { "node_modules/ts-morph/package.json": '{"name":"ts-morph"}\n' });
  return { root, dir };
}

function surfaceStub(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-deliver-stub-"));
  tmpDirs.push(dir);
  const path = join(dir, "surface-check.ts");
  writeFileSync(path, "// stub surface checker (the real one ships from the pack)\n");
  return path;
}

// --- calls ---------------------------------------------------------------------------

interface Call { readonly code: number; readonly text: string; readonly ms: number }

async function deliver(dir: string): Promise<Call> {
  let text = "";
  const io: Output = { out: (t) => { text += t; }, err: (t) => { text += t; } };
  const started = Date.now();
  const code = await main(["deliver"], dir, io);
  return { code, text, ms: Date.now() - started };
}

const ranLines = (root: string): string[] => {
  const path = join(root, "ran.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
};

let project: { root: string; dir: string } | undefined;
beforeEach(() => {
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
  vi.stubEnv("BOUNDED_HOST", undefined);
  vi.stubEnv("BOUNDED_JOB_DIR", undefined);
  vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", undefined);
  vi.stubEnv("BOUNDED_DELIVER_SURFACE_CHECK", surfaceStub());
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (project !== undefined) {
    for (const e of readGuardLog(project.dir)) {
      const pid = Number(e.detail?.["pid"]);
      if ((e.detail?.["kind"] === "job-started" || e.detail?.["kind"] === "job-restarted") && Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
  }
  project = undefined;
});

describe.skipIf(!HAS_BUN)("deliver as a background job", () => {
  test("a check longer than the host's deadline completes over repeated deliver calls, with no user step", async () => {
    project = proj();
    vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", "16000");
    const first = await deliver(project.dir);
    expect(first.code).toBe(3);
    expect(first.ms).toBeLessThan(3000);
    const calls: Call[] = [first];
    for (let i = 0; i < 40 && calls.at(-1)!.code === 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      calls.push(await deliver(project.dir));
    }
    const last = calls.at(-1)!;
    expect(last.code).toBe(0);
    expect(last.text).toContain("deliver: OK — ");
    for (const call of calls) expect(call.ms).toBeLessThan(3000);
    expect(ranLines(project.root)).toEqual(["ran"]);
    for (const call of calls) expect(userCommandViolations("deliver", call.text)).toEqual([]);
    const log = readGuardLog(project.dir);
    const started = log.findIndex((e) => e.guard === "deliver" && e.verdict === "running" && e.detail?.["kind"] === "job-started");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(log.slice(started + 1).some((e) => e.guard === "deliver" && e.verdict === "pass" && e.detail?.["step"] === "summary")).toBe(true);
    expect(deliveryState(readFileSync(join(project.dir, ".bounded", "guard-log.jsonl"), "utf8"))).toBe("delivered");
  }, 60_000);

  test("a delivered result is not reused", async () => {
    project = proj();
    vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", "16000");
    let call = await deliver(project.dir);
    for (let i = 0; i < 40 && call.code === 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      call = await deliver(project.dir);
    }
    expect(call.code).toBe(0);
    expect((await deliver(project.dir)).code).toBe(3);
  }, 60_000);

  test("without a deadline deliver runs in the call", async () => {
    project = proj();
    vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", undefined);
    const call = await deliver(project.dir);
    expect(call.code).toBe(0);
    expect(ranLines(project.root)).toEqual(["ran"]);
  }, 60_000);
});
