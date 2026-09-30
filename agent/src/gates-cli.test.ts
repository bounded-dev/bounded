import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { GateCommand } from "./gate-command.ts";
import { readGuardLog } from "../src/guard-log.ts";
import { makeTempProject, type TempProject } from "../test/support/temp-project.ts";
import { USAGE_EXIT, main } from "./gates-cli.ts";

// `bounded gates` end to end (ADR 2026-034): spawned, because the launcher, the
// symlink resolution and the exit code ARE the contract a shell sees. The
// gates chosen are the cheap ones — surface-check and contract-purity spawn
// nothing; typecheck runs the real tsc once on a one-file project.

const CLI = join(import.meta.dirname, "gates-cli.ts");
const LAUNCHER = join(import.meta.dirname, "..", "scripts", "bounded-gates");

const projects: TempProject[] = [];
afterAll(() => projects.forEach((p) => p.cleanup()));

function project(files: Readonly<Record<string, string>>, nodeModules = false): string {
  const p = makeTempProject(files, { prefix: "bounded-gates-", nodeModules });
  projects.push(p);
  return p.dir;
}

function run(args: readonly string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

/** The log minus the host declaration the CLI writes first (ADR 2026-034) —
 *  the gate-focused tests below are about the gate's own line. */
function gateEvents(dir: string) {
  return readGuardLog(dir).filter((e) => e.guard !== "host");
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

const CONTRACT = "export declare function create(): void;\n";

describe("usage (exit 64) and help (exit 0)", () => {
  const dir = project({});

  test("no gate: usage on stderr, 64", () => {
    const r = run([], dir);
    expect(r.status).toBe(USAGE_EXIT);
    expect(r.stderr).toMatch(/^usage: bounded gates <gate> \[cwd\] \[--json\] \[flags\]/);
    expect(r.stderr).toMatch(/\n  surface-check +Check every/);
    expect(r.stdout).toBe("");
  });

  test("--help: the same usage on stdout, 0", () => {
    const r = run(["--help"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^usage: bounded gates/);
  });

  test("unknown gate → 64, naming it", () => {
    const r = run(["no-such-gate"], dir);
    expect(r.status).toBe(USAGE_EXIT);
    expect(r.stderr).toMatch(/unknown gate 'no-such-gate'/);
  });

  test("unknown flag, missing value, and a second positional → 64 with the gate's usage", () => {
    for (const args of [
      ["typecheck", "--bogus"],
      ["typecheck", "--role"],
      ["typecheck", ".", "extra"],
    ]) {
      const r = run(args, dir);
      expect(r.status, args.join(" ")).toBe(USAGE_EXIT);
      expect(r.stderr, args.join(" ")).toMatch(/usage: bounded gates typecheck \[cwd\]/);
    }
  });

  test("<gate> --help prints the whole description and the flags", () => {
    const r = run(["sign-off", "--help"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^usage: bounded gates sign-off \[cwd\] \[--json\] \[flags\]/);
    expect(r.stdout).toContain("An EMPTY findings list is a valid and expected answer");
    expect(r.stdout).toMatch(/--findings <json>/);
    expect(r.stdout).toMatch(/--findings-file <string>/);
  });

  test("--list anywhere in argv lists, and runs no gate", () => {
    const r = run(["typecheck", "--list"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^usage: bounded gates/);
    expect(gateEvents(dir)).toEqual([]);
  });

  test("--list --json is an array of {name, tool, description, flags}", () => {
    const r = run(["--list", "--json"], dir);
    expect(r.status).toBe(0);
    const rows = parseJson(r.stdout);
    expect(Array.isArray(rows)).toBe(true);
    const names = Array.isArray(rows) ? rows.map((row: { name: string }) => row.name) : [];
    expect(names).toContain("red-gate");
    expect(names).toContain("surface-check");
    const drift = Array.isArray(rows) ? rows.find((row: { name: string }) => row.name === "check-drift") : undefined;
    expect(drift).toMatchObject({
      name: "check-drift",
      tool: "check_drift",
      flags: [],
    });
  });
});

describe("surface-check (spawns nothing)", () => {
  test("PASS: lines then the verdict line on stdout, exit 0, and a guard event", () => {
    const dir = project({
      "src/money/money.contract.ts": CONTRACT,
      "src/money/money.ts": "export function create(): void {}\n",
    });
    const r = run(["surface-check"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("surface-check: OK (1 contract pair)\nsurface-check: PASS\n");
    expect(r.stderr).toBe("");
    expect(gateEvents(dir)).toEqual([expect.objectContaining({ guard: "surface-check", verdict: "pass" })]);
  });

  test("BLOCK: everything on stderr, exit 1", () => {
    const dir = project({
      "src/money/money.contract.ts": CONTRACT,
      "src/money/money.ts": "export function create(extra: number): void {}\n",
    });
    const r = run(["surface-check"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/surface-check: FAIL/);
    expect(r.stderr).toMatch(/\nsurface-check: BLOCK\n$/);
    expect(gateEvents(dir)[0]).toMatchObject({ guard: "surface-check", verdict: "block" });
  });

  test("ERROR: no contracts is misuse, exit 2, with the explaining verdict line", () => {
    const dir = project({});
    const r = run(["surface-check"], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no src\/\*\*\/\*\.contract\.ts found/);
    expect(r.stderr).toMatch(/\nsurface-check: ERROR \(misuse — the gate could not run\)\n$/);
  });

  test("--json prints the envelope only, on stdout, whatever the code", () => {
    const dir = project({});
    const r = run(["surface-check", "--json"], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("");
    expect(parseJson(r.stdout)).toMatchObject({
      gate: "surface-check",
      verdict: "error",
      code: 2,
      route: null,
      detail: { violations: 0 },
    });
  });

  test("[cwd] is resolved relative to where the CLI runs", () => {
    const dir = project({
      "proj/src/a/a.contract.ts": CONTRACT,
      "proj/src/a/a.ts": "export function create(): void {}\n",
    });
    const r = run(["surface-check", "proj"], dir);
    expect(r.status).toBe(0);
    expect(gateEvents(join(dir, "proj"))).toHaveLength(1);
  });
});

describe("contract-purity", () => {
  test("ERROR when nothing matches — silence is not success", () => {
    const dir = project({});
    const r = run(["contract-purity", "--json"], dir);
    expect(r.status).toBe(2);
    expect(parseJson(r.stdout)).toMatchObject({ gate: "contract-purity", code: 2 });
    expect(gateEvents(dir)[0]).toMatchObject({ guard: "contract-purity", verdict: "error" });
  });
});

describe("typecheck (runs the real tsc once)", () => {
  const TSCONFIG = JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
    include: ["contexts"],
  });

  test("PASS on a clean one-file project", () => {
    const dir = project({ "tsconfig.json": TSCONFIG, "contexts/m/src/a.ts": "export const x: number = 1;\n" }, true);
    const r = run(["typecheck"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("typecheck: OK — no type errors\ntypecheck: PASS\n");
    expect(gateEvents(dir)).toEqual([expect.objectContaining({ guard: "typecheck", verdict: "pass" })]);
  });

  test("BLOCK on a type error, --role builder scopes and --json carries the detail", () => {
    const dir = project({ "tsconfig.json": TSCONFIG, "contexts/m/src/a.ts": 'export const x: number = "s";\n' }, true);
    const r = run(["typecheck", "--role", "builder", "--json"], dir);
    expect(r.status).toBe(1);
    expect(parseJson(r.stdout)).toMatchObject({
      gate: "typecheck",
      verdict: "block",
      code: 1,
      summary: "1 error",
      detail: { ok: false, errorCount: 1, scoped: true, hidden: 0 },
    });
    expect(r.stdout).toContain("contexts/m/src/a.ts(1,14): error TS2322");
    expect(gateEvents(dir)[0]).toMatchObject({ guard: "typecheck", verdict: "block", detail: { role: "builder" } });
  });

  test("an unknown --role is the gate's misuse (2), not the CLI's (64)", () => {
    const dir = project({});
    const r = run(["typecheck", "--role", "orchestrator"], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--role must be one of architect \| test-writer \| builder \| reviewer/);
  });

  // The host hands the CLI its role through the environment (ADR 2026-034);
  // the gate never resolves one itself, because it would resolve it against
  // the TARGET directory — Run 15's hole.
  test("BOUNDED_DEV_STAGE_ROLE scopes typecheck with no --role", () => {
    const dir = project({ "tsconfig.json": TSCONFIG, "contexts/m/src/a.ts": 'export const x: number = "s";\n' }, true);
    const r = spawnSync(process.execPath, [CLI, "typecheck", "--json"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, BOUNDED_DEV_STAGE_ROLE: "builder" },
    });
    expect(r.status).toBe(1);
    expect(parseJson(r.stdout)).toMatchObject({ gate: "typecheck", detail: { scoped: true } });
    expect(gateEvents(dir)[0]).toMatchObject({ guard: "typecheck", detail: { role: "builder" } });
  });
});

describe("a gate that throws", () => {
  const THROWS: GateCommand = {
    name: "throws",
    description: "A gate whose runner throws.",
    flags: [],
    async run() {
      throw new Error("boom");
    },
  };

  test("is ERROR in the contract's shape, exit 2, and leaves a guard line", async () => {
    const dir = project({});
    const out: string[] = [];
    const code = await main(["throws", "--json"], dir, { out: (t) => out.push(t), err: () => {} }, [THROWS]);
    expect(code).toBe(2);
    expect(parseJson(out.join(""))).toMatchObject({
      gate: "throws",
      verdict: "error",
      code: 2,
      summary: "boom",
      detail: { reason: "threw" },
    });
    expect(gateEvents(dir)).toEqual([
      expect.objectContaining({ guard: "throws", verdict: "error", summary: "boom", detail: { reason: "threw" } }),
    ]);
  });
});

describe("through the symlinks (the ~/.pi/agent case)", () => {
  test("the CLI module runs when its entry is a symlink", () => {
    const dir = project({});
    const link = join(dir, "gates-cli.link.ts");
    symlinkSync(CLI, link);
    const r = spawnSync(process.execPath, [link, "--list", "--json"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(Array.isArray(parseJson(r.stdout))).toBe(true);
  });

  test("the bounded gates launcher resolves itself through a symlink and execs the CLI", () => {
    const dir = project({});
    const link = join(dir, "bounded-gates");
    symlinkSync(LAUNCHER, link);
    const r = spawnSync(link, ["surface-check", "--json"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(parseJson(r.stdout)).toMatchObject({ gate: "surface-check", code: 2 });
  });
});

describe("host declaration (ADR 2026-034)", () => {
  test("a bare shell records `host none` — gates alone are never mistaken for a blind run", () => {
    const dir = project({});
    run(["contract-purity", "--json"], dir);
    const hosts = readGuardLog(dir).filter((e) => e.guard === "host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.summary).toBe(
      "host none: enforces nothing; unenforced: tool-strip, path-gate, phase-gate, scoped-views",
    );
    // Recorded on change: a second bare call adds no second line.
    run(["contract-purity", "--json"], dir);
    expect(readGuardLog(dir).filter((e) => e.guard === "host")).toHaveLength(1);
  });

  function hostsAfter(env: Readonly<Record<string, string>>) {
    const dir = project({});
    const r = spawnSync(process.execPath, [CLI, "contract-purity", "--json"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    expect(r.status).not.toBeNull();
    return readGuardLog(dir).filter((e) => e.guard === "host");
  }

  test("a host that named itself (BOUNDED_HOST) already declared itself — no `none` line", () => {
    expect(hostsAfter({ BOUNDED_HOST: "claude-code", BOUNDED_DEV_STAGE_ROLE: "builder" })).toHaveLength(0);
  });

  test("a role alone is not a host: BOUNDED_DEV_STAGE_ROLE by itself still records `none`", () => {
    const hosts = hostsAfter({ BOUNDED_DEV_STAGE_ROLE: "builder" });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.detail).toMatchObject({ host: "none" });
  });
});
