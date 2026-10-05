import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { deliveryState, runTicket } from "./change-run-status.ts";

const run = promisify(execFile);
const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "bounded-change-run-"));
  dirs.push(dir);
  return dir;
}

const line = (event: Record<string, unknown>): string => JSON.stringify(event);
const summary = line({ guard: "deliver", verdict: "pass", summary: "delivered", detail: { step: "summary" } });

describe("deliveryState", () => {
  test("no deliver event is undelivered", () => {
    expect(deliveryState("")).toBe("undelivered");
    expect(deliveryState(line({ guard: "design-gate", verdict: "pass", summary: "OK" }) + "\n")).toBe("undelivered");
  });

  test("only a passing summary step is completion", () => {
    expect(deliveryState(summary + "\n")).toBe("delivered");
    expect(deliveryState(line({ guard: "deliver", verdict: "pass", summary: "wired", detail: { step: "wire" } }))).toBe("undelivered");
    expect(deliveryState(line({ guard: "deliver", verdict: "pass", summary: "no detail" }))).toBe("undelivered");
  });

  test("a later failed delivery voids an earlier pass", () => {
    const failed = line({ guard: "deliver", verdict: "block", summary: "check red", detail: { step: "check" } });
    expect(deliveryState([summary, failed].join("\n"))).toBe("undelivered");
    expect(deliveryState([failed, summary].join("\n"))).toBe("delivered");
  });

  test("a running deliver event is not delivered and never malformed", () => {
    const running = line({ guard: "deliver", verdict: "running", summary: "running in the background", detail: { kind: "job-started" } });
    expect(deliveryState(running)).toBe("undelivered");
    expect(deliveryState([summary, running].join("\n"))).toBe("undelivered");
    expect(deliveryState([running, summary].join("\n"))).toBe("delivered");
    const poll = line({ guard: "gate-job", verdict: "running", summary: "deliver still running", detail: { kind: "job-running", gate: "deliver" } });
    expect(deliveryState([summary, poll].join("\n"))).toBe("delivered");
  });

  test("a malformed line or a missing verdict or summary is malformed", () => {
    expect(deliveryState(`${summary}\n{not json\n`)).toBe("malformed");
    expect(deliveryState(line({ guard: "deliver", summary: "no verdict" }))).toBe("malformed");
    expect(deliveryState(line({ guard: "deliver", verdict: "pass", detail: { step: "summary" } }))).toBe("malformed");
    expect(deliveryState(line({ guard: "deliver", verdict: "maybe", summary: "x" }))).toBe("malformed");
    expect(deliveryState("[]")).toBe("malformed");
  });
});

describe("runTicket", () => {
  test("runTicket names the latest ticket a run's log carries", () => {
    const prepared = (ticket: unknown) =>
      line({ guard: "team-lead", verdict: "pass", summary: "prepared", detail: { kind: "run-prepared", ticket } });
    const gated = (ticket: unknown) => line({ guard: "design-gate", verdict: "pass", summary: "OK", detail: { ticket } });
    expect(runTicket([prepared("4"), gated("4"), prepared("5")].join("\n"))).toBe("5");
    expect(runTicket([gated("4"), gated("5"), summary].join("\n"))).toBe("5");
    expect(runTicket([summary, line({ guard: "design-gate", verdict: "pass", summary: "OK" })].join("\n"))).toBeUndefined();
    expect(runTicket("")).toBeUndefined();
    expect(runTicket([gated("4"), gated("five"), gated(6)].join("\n"))).toBe("4");
  });
});

/** A ticket-numbered, project-local tree with a frozen manifest for #7. */
function tree(log?: string): string {
  const root = tmp();
  mkdirSync(join(root, "docs/tn"), { recursive: true });
  writeFileSync(join(root, "docs/tn/README.md"), "# Technical Notes\n");
  mkdirSync(join(root, ".bounded/tickets/7"), { recursive: true });
  writeFileSync(join(root, ".bounded/installation.json"), "{}\n");
  writeFileSync(join(root, ".bounded/active-ticket"), "7\n");
  writeFileSync(join(root, ".bounded/tickets/7/contract-checksums.json"), "{}\n");
  if (log !== undefined) writeFileSync(join(root, ".bounded/guard-log.jsonl"), log);
  return root;
}

async function script(name: string, args: readonly string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = { ...process.env, BOUNDED_TICKET: undefined, ...env };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  try {
    const { stdout, stderr } = await run("bash", [join(SCRIPTS, name), ...args], { cwd, env: merged as NodeJS.ProcessEnv });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("bounded change-run", () => {
  test("refuses to rotate a malformed log, even with --force", async () => {
    const root = tree("{not json\n");
    for (const args of [[root], ["--force", root]]) {
      const result = await script("bounded-change-run", args, root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("malformed guard log; refusing to rotate it");
    }
    expect(existsSync(join(root, ".bounded/guard-log.jsonl"))).toBe(true);
  });

  test("refuses an undelivered run unless --force abandons it", async () => {
    const root = tree(line({ guard: "design-gate", verdict: "pass", summary: "OK" }) + "\n");
    const refused = await script("bounded-change-run", [root], root);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("holds no final successful delivery");
    const forced = await script("bounded-change-run", ["--force", root], root);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("--force — abandoning an undelivered run");
    expect(existsSync(join(root, ".bounded/guard-log.jsonl"))).toBe(false);
    expect(readdirSync(join(root, ".bounded/guard-log-archive"))).toHaveLength(1);
  });

  test("--force marks the abandoned run's ticket", async () => {
    const prepared = line({ guard: "team-lead", verdict: "pass", summary: "prepared", detail: { kind: "run-prepared", ticket: "5" } });
    const gated = line({ guard: "design-gate", verdict: "pass", summary: "OK", detail: { ticket: "5" } });
    const root = tree(`${prepared}\n${gated}\n`);
    const forced = await script("bounded-change-run", ["--force", root], root);
    expect(forced.code).toBe(0);
    const marker = join(root, ".bounded/tickets/5/abandoned");
    expect(existsSync(marker)).toBe(true);
    const archived = readdirSync(join(root, ".bounded/guard-log-archive"));
    expect(archived).toHaveLength(1);
    expect((JSON.parse(readFileSync(marker, "utf8")) as { archive: string }).archive).toBe(archived[0]);
    expect(existsSync(join(root, ".bounded/tickets/7/abandoned"))).toBe(false);

    const anonymous = tree(line({ guard: "design-gate", verdict: "pass", summary: "OK" }) + "\n");
    const unnamed = await script("bounded-change-run", ["--force", anonymous], anonymous);
    expect(unnamed.code).toBe(0);
    expect(unnamed.stdout).toContain("names no ticket, so no ticket is marked abandoned");
    const tickets = join(anonymous, ".bounded/tickets");
    expect(readdirSync(tickets).filter((n) => existsSync(join(tickets, n, "abandoned")))).toEqual([]);
  });

  test("a delivered boundary clears the delivered run's abandoned marker", async () => {
    const prepared = line({ guard: "team-lead", verdict: "pass", summary: "prepared", detail: { kind: "run-prepared", ticket: "5" } });
    const root = tree(`${prepared}\n${summary}\n`);
    for (const n of [5, 7]) {
      mkdirSync(join(root, `.bounded/tickets/${n}`), { recursive: true });
      writeFileSync(join(root, `.bounded/tickets/${n}/abandoned`), "{}\n");
    }
    // The exit code is not asserted: this minimal tree cannot capture a
    // baseline, and the marker is cleared before the capture.
    await script("bounded-change-run", [root], root);
    expect(existsSync(join(root, ".bounded/tickets/5/abandoned"))).toBe(false);
    expect(existsSync(join(root, ".bounded/tickets/7/abandoned"))).toBe(true);

    const selected = tree(summary + "\n");
    writeFileSync(join(selected, ".bounded/tickets/7/abandoned"), "{}\n");
    // A log that names no ticket clears no marker: the selected ticket may not
    // be the one that delivered (review minor; the same rule as --force).
    const unnamed = await script("bounded-change-run", [selected], selected);
    expect(existsSync(join(selected, ".bounded/tickets/7/abandoned"))).toBe(true);
    expect(unnamed.stdout).toContain("the delivered run names no ticket, so no abandoned marker is cleared");
  });

  test("falls back to the active-ticket file, and BOUNDED_TICKET overrides it", async () => {
    const root = tree();
    const fromFile = await script("bounded-change-run", [root], root);
    expect(fromFile.stdout).toContain("no guard log to archive");
    expect(fromFile.code).toBe(0);
    const override = await script("bounded-change-run", [root], root, { BOUNDED_TICKET: "8" });
    expect(override.code).toBe(2);
    expect(override.stderr).toContain(".bounded/tickets/8/contract-checksums.json");
    rmSync(join(root, ".bounded/installation.json"));
    const unselected = await script("bounded-change-run", [root], root);
    expect(unselected.code).toBe(2);
    expect(unselected.stderr).toContain("no active ticket");
  });
});

describe("bounded ticket", () => {
  function fakePi(): string {
    const bin = tmp();
    writeFileSync(join(bin, "pi"), '#!/usr/bin/env bash\necho "pi ticket=${BOUNDED_TICKET:-} $*"\n');
    chmodSync(join(bin, "pi"), 0o755);
    return bin;
  }

  test("launches for the lead's selected ticket without --ticket", async () => {
    const root = tree();
    const env = { PATH: `${fakePi()}:${process.env.PATH ?? ""}` };
    const launched = await script("bounded-ticket", [], root, env);
    expect(launched.code).toBe(0);
    expect(launched.stdout).toMatch(/^pi ticket= --extension .*architect\.ts --exclude-tools/);
    const explicit = await script("bounded-ticket", ["--ticket", "9"], root, env);
    expect(explicit.stdout).toContain("pi ticket=9 ");
  });

  test("refuses a ticket-numbered project with no selection", async () => {
    const root = tree();
    rmSync(join(root, ".bounded/active-ticket"));
    const refused = await script("bounded-ticket", [], root, { PATH: `${fakePi()}:${process.env.PATH ?? ""}` });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("no active ticket");
    const bad = await script("bounded-ticket", ["--ticket", "x"], root);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--ticket needs a positive issue number");
  });
});
