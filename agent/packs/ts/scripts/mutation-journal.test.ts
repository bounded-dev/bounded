import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { readGuardLog } from "../../../src/guard-log.ts";
import { gates } from "../gates.ts";
import { runMutationScore } from "./mutation-score.ts";

// Issue #48: a mutation-score run killed mid-mutant left `!==` in the user's
// source, and nothing said so. These tests kill a real measuring process at
// its first mutant and check what the next gate, and the next measurement,
// make of the tree it left.

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// --- fixture: the 12-site project of mutation-score.test.ts -------------------------

const MONEY_TS = `export function parseAmount(raw: unknown): number | undefined {
  if (typeof raw !== "number") {
    return undefined;
  }
  if (raw < 0 || raw > 100) return undefined;
  return Math.round(raw);
}
`;

const TIER_TS = `export function tierFor(score: number): string {
  if (score >= 90) return "gold";
  if (score >= 50) return "silver";
  return "bronze";
}
`;

const PRISTINE: Readonly<Record<string, string>> = {
  "contexts/pm/src/money.ts": MONEY_TS,
  "contexts/pm/src/tier.ts": TIER_TS,
};

function proj(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mutation-journal-"));
  tmpDirs.push(dir);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "bun test" } }),
    ".bounded/composed-packs.json": JSON.stringify(["ts", "ts-hexagonal"]),
    ...PRISTINE,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** The mutable files that no longer hold what the fixture wrote. */
function dirtyFiles(dir: string): string[] {
  return Object.keys(PRISTINE).filter((rel) => readFileSync(join(dir, rel), "utf8") !== PRISTINE[rel]);
}

// --- the measuring process ----------------------------------------------------------
//
// A child node process runs the real runMutationScore with an injected suite
// runner: the baseline answers green, the first mutant writes a marker and
// hangs. A setInterval keeps the process alive (a never-settling promise alone
// lets node exit). With `service`, the policy prepares a fake service whose
// release writes a second marker.

const MUTATION_SCORE = join(import.meta.dirname, "mutation-score.ts");

const DRIVER = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMutationScore } from ${JSON.stringify(MUTATION_SCORE)};

const [dir, markers, mode] = process.argv.slice(2);
setInterval(() => {}, 60_000);
let call = 0;
const runSuite = async () => {
  if (call++ === 0) return { ok: true, note: "green" };
  writeFileSync(join(markers, "at-mutant"), "");
  return new Promise(() => {});
};
const policy = mode === "service"
  ? {
      refusals: [],
      env: { set: {}, unset: [] },
      prepares: [{
        name: "fake-service",
        prepare: async () => ({ description: "started a fake service", env: {}, release: () => writeFileSync(join(markers, "released"), "") }),
      }],
    }
  : undefined;
await runMutationScore(dir, { minimumSample: 1, maxMutants: 1, runSuite, ...(policy === undefined ? {} : { policy }) });
`;

interface Measuring {
  readonly child: ChildProcess;
  readonly markers: string;
  readonly stderr: () => string;
}

/** Start the measuring process and wait until it holds its first mutant. */
async function measureUntilFirstMutant(dir: string, mode: "plain" | "service" = "plain"): Promise<Measuring> {
  const markers = mkdtempSync(join(tmpdir(), "pi-mutation-markers-"));
  tmpDirs.push(markers);
  const driver = join(markers, "driver.mjs");
  writeFileSync(driver, DRIVER);
  const env = { ...process.env };
  delete env["BOUNDED_GUARD_LOG"];
  const child = spawn(process.execPath, [driver, dir, markers, mode], { env, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const until = Date.now() + 20_000;
  while (!existsSync(join(markers, "at-mutant"))) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the measuring process ended early: ${stderr}`);
    if (Date.now() > until) throw new Error(`the measuring process never reached a mutant: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, markers, stderr: () => stderr };
}

/** Kill outright (no handler runs), and wait until the process is gone. */
async function killOutright(measuring: Measuring): Promise<void> {
  const exited = once(measuring.child, "exit");
  measuring.child.kill("SIGKILL");
  await exited;
}

const checkDrift = () => {
  const gate = gates.find((g) => g.name === "check-drift");
  if (gate === undefined) throw new Error("no check-drift gate in the registry");
  return gate;
};

describe("a mutant left by a killed measurement", () => {
  test("a killed run's mutant is restored by the next run of any gate, and the restore is logged", async () => {
    const dir = proj();
    const measuring = await measureUntilFirstMutant(dir);
    await killOutright(measuring);
    const left = dirtyFiles(dir);
    expect(left).toHaveLength(1); // precondition: the kill left a mutant

    await checkDrift().run(dir, {});

    expect(dirtyFiles(dir)).toEqual([]);
    for (const [rel, content] of Object.entries(PRISTINE)) expect(readFileSync(join(dir, rel)).equals(Buffer.from(content))).toBe(true);
    const restored = readGuardLog(dir).filter((e) => e.guard === "mutation-score" && e.detail?.["kind"] === "leftover-restored");
    expect(restored).toHaveLength(1);
    expect(restored[0]!.detail).toMatchObject({ file: left[0] });
    expect(restored[0]!.detail?.["mutation"]).toEqual(expect.any(String));
  });

  test("while the measuring process is alive, a gate refuses and leaves the tree alone", async () => {
    const dir = proj();
    const measuring = await measureUntilFirstMutant(dir);
    const mutated = dirtyFiles(dir);
    expect(mutated).toHaveLength(1);

    const result = await checkDrift().run(dir, {});

    expect(result.code).toBe(1);
    expect(result.verdict).toBe("block");
    expect(result.summary).toContain("mutation-score");
    expect(result.summary).toContain(mutated[0]);
    expect(dirtyFiles(dir)).toEqual(mutated);
    await killOutright(measuring);
  });

  test("the next mutation-score run restores a leftover before its baseline", async () => {
    const dir = proj();
    await killOutright(await measureUntilFirstMutant(dir));
    expect(dirtyFiles(dir)).toHaveLength(1);

    const dirtyAtBaseline: string[][] = [];
    let call = 0;
    await runMutationScore(dir, {
      minimumSample: 1,
      maxMutants: 1,
      runSuite: async (cwd) => {
        if (call++ === 0) dirtyAtBaseline.push(dirtyFiles(cwd));
        return { ok: true, note: "green" };
      },
    });

    expect(dirtyAtBaseline).toEqual([[]]);
  });

  test("a leftover file edited since the kill is not touched, and every gate says why", async () => {
    const dir = proj();
    await killOutright(await measureUntilFirstMutant(dir));
    const [mutated] = dirtyFiles(dir);
    expect(mutated).toBeDefined();
    appendFileSync(join(dir, mutated!), "// edited by a person after the kill\n");
    const edited = readFileSync(join(dir, mutated!), "utf8");

    const result = await checkDrift().run(dir, {});

    expect(result.code).toBe(1);
    expect(result.verdict).toBe("block");
    expect(result.summary).toContain(mutated);
    expect(readFileSync(join(dir, mutated!), "utf8")).toBe(edited);
  });
});

describe("an interrupted measurement", () => {
  test.each(["SIGTERM", "SIGINT"] as const)(
    "%s restores the file in flight, releases the prepared service, logs the interruption, and the process dies of that signal",
    async (signal) => {
      const dir = proj();
      const measuring = await measureUntilFirstMutant(dir, "service");
      expect(dirtyFiles(dir)).toHaveLength(1);

      const exited = once(measuring.child, "exit");
      measuring.child.kill(signal);
      const [, diedOf] = await exited;

      expect(diedOf, measuring.stderr()).toBe(signal);
      expect(dirtyFiles(dir)).toEqual([]);
      expect(existsSync(join(measuring.markers, "released"))).toBe(true);
      const interrupted = readGuardLog(dir).filter((e) => e.guard === "mutation-score" && e.detail?.["kind"] === "interrupted");
      expect(interrupted).toHaveLength(1);
    },
  );
});
