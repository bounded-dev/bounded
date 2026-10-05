import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { discoverGates, gateUsage, main, type Output } from "./gates-cli.ts";
import { readGuardLog, type LoggedGuardEvent } from "./guard-log.ts";
import { TICKET_MARKER_RELATIVE } from "./ticket-worktree.ts";
import { FakeTracker } from "../test/support/fake-tracker.ts";
import { writeFakeJobPack } from "../test/fixtures/fake-job-pack.ts";
import { userCommandViolations } from "../test/fixtures/user-steps.ts";

// Long gates run as detached, resumable jobs (ADR 2026-073). Under a host
// deadline (BOUNDED_COMMAND_TIMEOUT_MS) a long gate starts its run in the
// background and answers RUNNING once the call's budget is spent; the next
// call with the same arguments waits again, or collects the verdict. Without a
// deadline it runs in the call. A deadline of 16000 ms gives a 1000 ms budget;
// sleeps of a few seconds stand in for checks that outlast a host's limit.

const DEADLINE = "16000";

let root = "";
let project = "";
let packs = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-gate-jobs-")));
  project = join(root, "project");
  packs = join(root, "packs");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "a.txt"), "a\n");
  writeFakeJobPack(packs);
  vi.stubEnv("BOUNDED_GUARD_LOG", "");
  vi.stubEnv("BOUNDED_HOST", undefined);
  vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", undefined);
  vi.stubEnv("BOUNDED_JOB_DIR", undefined);
  vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  // Stop every run a test started, then remove its files.
  for (const dir of [project, join(root, "ticket")]) {
    for (const pid of startedPids(dir)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  rmSync(root, { recursive: true, force: true });
});

const deadline = (): void => { vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", DEADLINE); };
const noDeadline = (): void => { vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", undefined); };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Call { readonly code: number; readonly lines: readonly string[]; readonly text: string }

async function call(argv: readonly string[], options: { cwd?: string; packsDir?: string; open?: () => FakeTracker } = {}): Promise<Call> {
  let text = "";
  const io: Output = { out: (t) => { text += t; }, err: (t) => { text += t; } };
  const code = await main(argv, options.cwd ?? project, io, undefined, options.packsDir ?? packs, options.open);
  return { code, text, lines: text.trimEnd().split("\n") };
}

/** Call until the answer is not RUNNING: every 500 ms, up to 20 times. */
async function poll(argv: readonly string[], options: Parameters<typeof call>[1] = {}): Promise<Call> {
  let last = await call(argv, options);
  for (let i = 0; i < 20 && last.code === 3; i++) {
    await sleep(500);
    last = await call(argv, options);
  }
  return last;
}

const runs = (): string[] => {
  const path = join(root, "runs.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter((l) => l !== "") : [];
};
async function until(condition: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(100);
  }
}

const kindOf = (e: LoggedGuardEvent): unknown => e.detail?.["kind"];
const jobEvents = (dir: string, kind: string): LoggedGuardEvent[] => readGuardLog(dir).filter((e) => kindOf(e) === kind);
function startedPids(dir: string): number[] {
  return readGuardLog(dir)
    .filter((e) => kindOf(e) === "job-started" || kindOf(e) === "job-restarted")
    .map((e) => Number(e.detail?.["pid"]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a long gate under a host deadline", () => {
  test("under a deadline a long gate answers RUNNING, exits 3 and finishes in the background", async () => {
    deadline();
    const started = Date.now();
    const first = await call(["slow", "--ms", "3000"]);
    expect(first.code).toBe(3);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(first.lines.at(-1)!.startsWith("slow: RUNNING")).toBe(true);
    expect(existsSync(join(root, "runs.log"))).toBe(false);
    await until(() => runs().length === 1);
    expect(runs()).toEqual(["slow"]);
  }, 20_000);

  test("the next call collects the result once; the call after starts afresh", async () => {
    deadline();
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    await until(() => runs().length === 1);
    const collected = await call(["slow", "--ms", "3000"]);
    expect(collected.code).toBe(0);
    expect(collected.lines).toContain("slow: done");
    expect(collected.lines.at(-1)).toBe("slow: PASS");
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    await until(() => runs().length === 2);
  }, 30_000);

  test("the budget counts the call's own work", async () => {
    deadline();
    const started = Date.now();
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    expect(Date.now() - started).toBeLessThan(1000 + 500);
  }, 20_000);

  test("a long gate finishing within the budget answers in one call", async () => {
    deadline();
    expect((await call(["slow", "--ms", "100"])).code).toBe(0);
  }, 20_000);

  test("without a deadline a long gate runs in the call", async () => {
    noDeadline();
    const result = await call(["slow", "--ms", "1500"]);
    expect(result.code).toBe(0);
    expect(runs()).toEqual(["slow"]);
  }, 20_000);

  test("without a deadline a live job is waited for and collected, never run twice", async () => {
    deadline();
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    noDeadline();
    expect((await call(["slow", "--ms", "3000"])).code).toBe(0);
    expect(runs()).toEqual(["slow"]);
  }, 30_000);

  test("one live long-gate run per project", async () => {
    deadline();
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    const refused = await call(["slow2", "--ms", "100"]);
    expect(refused.code).toBe(2);
    expect(refused.text).toContain("slow");
    expect(refused.text).toMatch(/call slow again to collect it first/);
    expect(readGuardLog(project).some((e) => e.guard === "slow2" && e.verdict === "error")).toBe(true);
    await until(() => runs().length === 1);
    expect((await poll(["slow", "--ms", "3000"])).code).toBe(0);
    expect((await poll(["slow2", "--ms", "100"])).code).toBe(0);
    expect(runs()).toEqual(["slow", "slow2"]);
  }, 40_000);

  test("an inline run holds the slot too", async () => {
    noDeadline();
    const inline = call(["slow", "--ms", "2000"]);
    await sleep(300);
    deadline();
    const refused = await call(["slow2", "--ms", "100"]);
    expect(refused.code).toBe(2);
    expect(refused.text).toMatch(/call slow again to collect it first/);
    expect((await inline).code).toBe(0);
  }, 20_000);

  test("a tree changed after the job ended discards its result", async () => {
    deadline();
    expect((await call(["slow", "--ms", "1500"])).code).toBe(3);
    appendFileSync(join(project, "src", "a.txt"), "changed\n");
    await until(() => runs().length === 1);
    expect((await call(["slow", "--ms", "1500"])).code).toBe(3);
    expect(jobEvents(project, "job-restarted").at(-1)?.detail).toMatchObject({ reason: "tree-changed" });
    expect((await poll(["slow", "--ms", "1500"])).code).toBe(0);
    expect(runs()).toEqual(["slow", "slow"]);
  }, 40_000);

  test("the role does not change the key", async () => {
    deadline();
    vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", "architect");
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", "builder");
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    expect(jobEvents(project, "job-restarted")).toEqual([]);
    expect(jobEvents(project, "job-running").length).toBeGreaterThan(0);
    await until(() => runs().length === 1);
    await sleep(500);
    expect(runs()).toEqual(["slow"]);
  }, 20_000);

  test("different arguments stop a running job and start another", async () => {
    deadline();
    expect((await call(["slow", "--ms", "3000", "--marker", "A"])).code).toBe(3);
    expect((await call(["slow", "--ms", "3000", "--marker", "B"])).code).toBe(3);
    expect(jobEvents(project, "job-restarted").at(-1)?.detail).toMatchObject({ reason: "args-changed" });
    await sleep(6000);
    expect(existsSync(join(root, "A"))).toBe(false);
    expect(existsSync(join(root, "B"))).toBe(true);
  }, 30_000);

  test("a job killed outright is restarted; the third death is a harness bug until the tree changes", async () => {
    deadline();
    expect((await call(["slow", "--ms", "30000"])).code).toBe(3);
    for (let death = 1; death <= 3; death++) {
      const pid = startedPids(project).at(-1)!;
      process.kill(-pid, "SIGKILL");
      await until(() => !alive(pid));
      const next = await call(["slow", "--ms", "30000"]);
      if (death < 3) {
        expect(next.code, `after death ${death}`).toBe(3);
        expect(jobEvents(project, "job-restarted").at(-1)?.detail).toMatchObject({ reason: "dead" });
        expect(jobEvents(project, "job-restarted")).toHaveLength(death);
      } else {
        expect(next.code).toBe(2);
        expect(next.text).toMatch(/died 3 times/);
        expect(next.text).toMatch(/harness bug/);
        expect(userCommandViolations("gate-jobs", next.text)).toEqual([]);
        expect(readGuardLog(project).some((e) => e.guard === "slow" && e.verdict === "error")).toBe(true);
      }
    }
    const starts = (): number => jobEvents(project, "job-started").length + jobEvents(project, "job-restarted").length;
    const before = starts();
    expect((await call(["slow", "--ms", "30000"])).code).toBe(2);
    expect(starts()).toBe(before);
    appendFileSync(join(project, "src", "a.txt"), "changed\n");
    expect((await call(["slow", "--ms", "30000"])).code).toBe(3);
  }, 60_000);

  test("a reads-tree gate whose own run changes the tree blocks under its own guard", async () => {
    deadline();
    const result = await poll(["writer"]);
    expect(result.code).toBe(1);
    expect(result.text).toMatch(/changed while writer ran/);
    expect(result.lines).toContain("writer: route → architect");
    const log = readGuardLog(project);
    const ownPass = log.findIndex((e) => e.guard === "writer" && e.verdict === "pass");
    expect(ownPass).toBeGreaterThanOrEqual(0);
    expect(log.slice(ownPass + 1).some((e) => e.guard === "writer" && e.verdict === "block")).toBe(true);
    expect(log.some((e) => e.guard === "gate-job" && kindOf(e) === "job-collected" && e.detail?.["gate"] === "writer")).toBe(false);
  }, 30_000);

  test("prepare runs before the start tree is taken", async () => {
    writeFileSync(join(project, "src", "a.txt"), "mutant\n");
    deadline();
    expect((await call(["prepped"])).code).toBe(3);
    const result = await poll(["prepped"]);
    expect(result.code).toBe(0);
    expect(readFileSync(join(project, "src", "a.txt"), "utf8")).toBe("restored\n");
  }, 30_000);

  test("a writes-tree gate is collected over the tree it left", async () => {
    deadline();
    expect((await call(["shipper"])).code).toBe(3);
    expect((await poll(["shipper"])).code).toBe(0);
    expect(existsSync(join(project, "shipped.txt"))).toBe(true);
  }, 30_000);

  test("a gate cannot answer RUNNING itself", async () => {
    const result = await call(["liar"]);
    expect(result.code).toBe(2);
    expect(result.text).toMatch(/cannot answer RUNNING/);
    expect(readGuardLog(project).some((e) => e.guard === "liar" && e.verdict === "error")).toBe(true);
  });

  test("two concurrent calls start one job", async () => {
    deadline();
    const both = await Promise.all([call(["slow", "--ms", "2000"]), call(["slow", "--ms", "2000"])]);
    for (const one of both) expect([0, 3]).toContain(one.code);
    expect((await poll(["slow", "--ms", "2000"])).code).toBe(0);
    await sleep(1000);
    expect(runs()).toEqual(["slow"]);
  }, 30_000);

  test("start and restart are running events under the gate's guard; polls and pass-through collection are under gate-job", async () => {
    deadline();
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    await until(() => runs().length === 1);
    expect((await call(["slow", "--ms", "3000"])).code).toBe(0);
    const log = readGuardLog(project);
    expect(log.some((e) => e.guard === "slow" && e.verdict === "running" && kindOf(e) === "job-started")).toBe(true);
    expect(log.some((e) => e.guard === "gate-job" && e.verdict === "running" && kindOf(e) === "job-running")).toBe(true);
    expect(log.some((e) => e.guard === "gate-job" && kindOf(e) === "job-collected" && e.detail?.["gate"] === "slow")).toBe(true);
    const ownPass = log.findIndex((e) => e.guard === "slow" && e.verdict === "pass");
    expect(ownPass).toBeGreaterThanOrEqual(0);
    expect(log.slice(ownPass + 1).filter((e) => e.guard === "slow")).toEqual([]);
  }, 30_000);

  test("a board update that fails still releases the collected job", async () => {
    const ticket = join(root, "ticket");
    mkdirSync(join(ticket, "src"), { recursive: true });
    writeFileSync(join(ticket, "src", "a.txt"), "a\n");
    execFileSync("git", ["init", "-q", ticket]);
    writeFileSync(join(ticket, ".gitignore"), ".bounded/\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A"], { cwd: ticket });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"], { cwd: ticket });
    mkdirSync(join(ticket, ".bounded"), { recursive: true });
    writeFileSync(join(ticket, TICKET_MARKER_RELATIVE), JSON.stringify({ issue: 7, branch: "ticket/7", main: "/m" }));
    const tracker = new FakeTracker();
    tracker.seed({ number: 7, title: "t", status: "Building" });
    const open = (): FakeTracker => tracker;
    deadline();
    expect((await call(["slow", "--ms", "1500"], { cwd: ticket, open })).code).toBe(3);
    await until(() => runs().length === 1);
    tracker.failAfter = 1; // the check answers; the comment fails
    const collected = await call(["slow", "--ms", "1500", "--json"], { cwd: ticket, open });
    expect(collected.code).toBe(2);
    expect(JSON.parse(collected.text)).toMatchObject({ detail: { board: "pending" } });
    tracker.failAfter = undefined;
    expect((await call(["slow", "--ms", "1500"], { cwd: ticket, open })).code).toBe(3);
  }, 30_000);

  test("a job recorded with another packs directory is discarded", async () => {
    deadline();
    expect((await call(["slow", "--ms", "1500"])).code).toBe(3);
    await until(() => runs().length === 1);
    const copy = join(root, "packs-copy");
    cpSync(packs, copy, { recursive: true });
    expect((await call(["slow", "--ms", "1500"], { packsDir: copy })).code).toBe(3);
    expect(jobEvents(project, "job-restarted").at(-1)?.detail).toMatchObject({ reason: "packs-changed" });
  }, 30_000);

  test("the job's stdio is not the caller's", () => {
    const launcher = join(root, "launch.ts");
    writeFileSync(launcher, [
      `import { main } from ${JSON.stringify(join(import.meta.dirname, "gates-cli.ts"))};`,
      `process.exit(await main(process.argv.slice(2), process.cwd(), undefined, undefined, ${JSON.stringify(packs)}));`,
    ].join("\n"));
    const started = Date.now();
    const run = spawnSync(process.execPath, [launcher, "slow", "--ms", "3000"], {
      cwd: project, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, BOUNDED_COMMAND_TIMEOUT_MS: DEADLINE, BOUNDED_GUARD_LOG: "" },
    });
    expect(run.status).toBe(3);
    expect(Date.now() - started).toBeLessThan(2500);
  }, 20_000);

  test("a long gate's help says to call again on RUNNING", async () => {
    const gates = await discoverGates(packs);
    const usageOf = (name: string): string => gateUsage(gates.find((g) => g.name === name)!);
    expect(usageOf("slow")).toContain("RUNNING");
    expect(usageOf("slow")).toContain("call it again");
    expect(usageOf("quick")).not.toContain("RUNNING");
  });
});
