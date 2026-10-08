import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { acquireLock } from "./process-lock.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { discoverGates, gateUsage, main, type Output } from "./gates-cli.ts";
import { readGuardLog, type LoggedGuardEvent } from "./guard-log.ts";
import { TICKET_MARKER_RELATIVE } from "./ticket-worktree.ts";
import { FakeTracker } from "../test/support/fake-tracker.ts";
import { writeFakeJobPack } from "../test/fixtures/fake-job-pack.ts";
import { userCommandViolations } from "../test/fixtures/user-steps.ts";

// Long gates run as detached, resumable jobs (ADR LEG-2026-073). Under a host
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
/** Has the gate's current background run written its result? */
const resultWritten = (gate: string, dir = project): boolean => {
  const jobDir = join(dir, ".bounded", "jobs", `gate-${gate}`);
  return existsSync(jobDir) && readdirSync(jobDir).some((name) => /^result-.*\.json$/.test(name));
};
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

  // Pins: an exclusive gate (slow2) refuses to start beside a running reader (slow).
  test("one live long-gate run per project", async () => {
    deadline();
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    const refused = await call(["slow2", "--ms", "100"]);
    expect(refused.code).toBe(2);
    expect(refused.text).toContain("slow");
    expect(refused.text).toMatch(/call slow again to collect it first/);
    // A refusal ran nothing: it is the core's record, never the gate's verdict (review minor 8).
    expect(readGuardLog(project).some((e) => e.guard === "gate-job" && kindOf(e) === "job-refused" && e.detail?.["gate"] === "slow2")).toBe(true);
    expect(readGuardLog(project).some((e) => e.guard === "slow2")).toBe(false);
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
    expect(refused.text).toMatch(/slow is running now in another call/);
    expect((await inline).code).toBe(0);
  }, 20_000);

  test("a tree changed after the job ended discards its result", async () => {
    deadline();
    expect((await call(["slow", "--ms", "1500"])).code).toBe(3);
    await until(() => resultWritten("slow"));
    appendFileSync(join(project, "src", "a.txt"), "changed\n");
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

// Final review of #53. The ruling on the slot: never two runs of one gate,
// inline or job; a gate that changes the tree (`writes-tree`) runs alone;
// gates that only read it may run alongside each other (ADR LEG-2026-021).
describe("which long runs may overlap", () => {
  // Review M1: an in-call run was invisible to a deadline call of the same gate.
  test("a deadline call never starts a second run of a gate running now in another call", async () => {
    noDeadline();
    const inline = call(["slow", "--ms", "2000"]);
    await sleep(300);
    deadline();
    const second = await call(["slow", "--ms", "2000"]);
    expect(second.code).toBe(2);
    expect(second.text).toMatch(/slow is running now in another call/);
    expect((await inline).code).toBe(0);
    await sleep(2500);
    expect(runs()).toEqual(["slow"]);
  }, 20_000);

  test("two calls without a deadline never run one gate twice at once", async () => {
    noDeadline();
    const both = await Promise.all([call(["slow", "--ms", "1500"]), call(["slow", "--ms", "1500"])]);
    expect(both.map((c) => c.code).sort()).toEqual([0, 2]);
    expect(both.find((c) => c.code === 2)!.text).toMatch(/slow is running now in another call/);
    expect(runs()).toEqual(["slow"]);
  }, 20_000);

  test("gates that only read the tree run alongside each other", async () => {
    deadline();
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    expect((await call(["slow3", "--ms", "1500"])).code).toBe(3);
    expect((await poll(["slow3", "--ms", "1500"])).code).toBe(0);
    expect((await poll(["slow", "--ms", "3000"])).code).toBe(0);
  }, 30_000);

  test("a gate that writes the tree runs alone, either way round", async () => {
    deadline();
    expect((await call(["shipper"])).code).toBe(3);
    const reader = await call(["slow", "--ms", "100"]);
    expect(reader.code).toBe(2);
    expect(reader.text).toMatch(/call shipper again to collect it first/);
    expect((await poll(["shipper"])).code).toBe(0);
    expect((await call(["slow", "--ms", "3000"])).code).toBe(3);
    const writer = await call(["shipper"]);
    expect(writer.code).toBe(2);
    expect(writer.text).toMatch(/call slow again to collect it first/);
  }, 30_000);

  test("a refusal never tells a role to call a gate it cannot call", async () => {
    deadline();
    expect((await call(["shipper"])).code).toBe(3);
    vi.stubEnv("BOUNDED_DEV_STAGE_ROLE", "builder");
    const refused = await call(["slow", "--ms", "100"]);
    expect(refused.code).toBe(2);
    expect(refused.text).not.toMatch(/call shipper/);
    expect(refused.text).toMatch(/shipper is running/);
    expect(refused.text).toMatch(/wait for it to finish, then call slow again/);
  }, 20_000);

  // Review minor 3: `running` is the harness's verdict whatever the code.
  test("a gate that claims the running verdict with another code is an ERROR", async () => {
    const result = await call(["fibber"]);
    expect(result.code).toBe(2);
    expect(result.text).toMatch(/cannot answer RUNNING/);
  });

  // Review minor 8: a refusal to start must not touch the delivery evidence.
  test("a refused delivering gate leaves the delivery snapshot and the gate's log alone", async () => {
    const ticket = join(root, "ticket");
    mkdirSync(join(ticket, "src"), { recursive: true });
    writeFileSync(join(ticket, "src", "a.txt"), "a\n");
    execFileSync("git", ["init", "-q", ticket]);
    writeFileSync(join(ticket, ".gitignore"), ".bounded/\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A"], { cwd: ticket });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"], { cwd: ticket });
    mkdirSync(join(ticket, ".bounded"), { recursive: true });
    writeFileSync(join(ticket, TICKET_MARKER_RELATIVE), JSON.stringify({ issue: 7, branch: "ticket/7", main: "/m" }));
    const snapshot = join(ticket, ".bounded", "delivery-snapshot.json");
    writeFileSync(snapshot, JSON.stringify({ tree: "t", index: "i" }));
    const tracker = new FakeTracker();
    tracker.seed({ number: 7, title: "t", status: "Awaiting Merge" });
    const open = (): FakeTracker => tracker;
    deadline();
    expect((await call(["slow", "--ms", "3000"], { cwd: ticket, open })).code).toBe(3);
    const refused = await call(["shipper"], { cwd: ticket, open });
    expect(refused.code).toBe(2);
    expect(readFileSync(snapshot, "utf8")).toBe(JSON.stringify({ tree: "t", index: "i" }));
    expect(readGuardLog(ticket).some((e) => e.guard === "shipper")).toBe(false);
    expect(tracker.issues.get(7)!.comments.some((c) => c.includes("shipper"))).toBe(false);
  }, 30_000);

  // Review minor 10: the job lock is waited on only as long as the call may take.
  test("a held job lock is waited on only for the call's budget", async () => {
    mkdirSync(join(project, ".bounded", "jobs"), { recursive: true });
    const lock = acquireLock(join(project, ".bounded", "jobs", "lock"));
    expect(lock.ok).toBe(true);
    try {
      deadline();
      const started = Date.now();
      const result = await call(["slow", "--ms", "100"]);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(result.code).toBe(2);
      expect(result.text).toMatch(/call slow again/);
    } finally {
      if (lock.ok) lock.release();
    }
  }, 20_000);

  // Review minor 11: the job mechanism is core, so it names no technology,
  // comments included (AGENTS.md: the extension model).
  test("the core's job mechanism names no technology", () => {
    for (const file of ["gate-jobs.ts", "detached-job.ts", "job-runner.ts", "gate-job-worker.ts", "tree-fingerprint.ts", "gate-discovery.ts"]) {
      const text = readFileSync(join(import.meta.dirname, file), "utf8");
      expect(text, file).not.toMatch(/TypeScript|\bBun\b|Docker|Postgres|Testcontainers|container engine|vitest/i);
    }
  });

  // Re-review 2: a measurement restores every mutant it writes, so an edit by
  // anyone else during its run voids its result, as for a reader.
  test("an edit during a run of a gate that runs alone and reads the tree is a BLOCK, not a verdict", async () => {
    deadline();
    expect((await call(["measure", "--ms", "3000"])).code).toBe(3);
    await until(() => existsSync(join(root, "measure-started")));
    appendFileSync(join(project, "src", "a.txt"), "edited mid-run\n");
    const result = await poll(["measure", "--ms", "3000"]);
    expect(result.code).toBe(1);
    expect(result.text).toMatch(/changed while measure ran/);
  }, 30_000);

  // Re-review 3: a dead exclusive run whose commands live on still holds the project.
  test("a dead exclusive run whose processes live on still keeps others out", async () => {
    deadline();
    expect((await call(["slow2", "--ms", "30000"])).code).toBe(3);
    const runner = startedPids(project).at(-1)!;
    process.kill(runner, "SIGKILL"); // the runner alone: its worker lives on in the group
    await until(() => !alive(runner));
    const refused = await call(["slow", "--ms", "100"]);
    expect(refused.code).toBe(2);
    expect(refused.text).toMatch(/slow2/);
  }, 20_000);
});
