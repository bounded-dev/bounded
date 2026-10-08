import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import installArchitectTools from "../../hosts/pi/extensions/architect-tools.ts";
import installDevTools from "../../hosts/pi/extensions/dev-tools.ts";
import { paramName, toolFlags, toolParams } from "../../hosts/pi/extensions/lib/gate-tools.ts";
import { isGateCommand } from "../../src/gate-command.ts";
import { ARTIFACT_GATE_TOOLS } from "../../src/path-policy.ts";
import { makeTempProject, type TempProject } from "../../test/support/temp-project.ts";
import { deadlineForBudgetMs, gates, mutationBudgetMs } from "./gates.ts";
import { writeJournal } from "./scripts/mutation-journal.ts";
import { parseFindings } from "./scripts/sign-off.ts";

// The registry is the one place a gate's public face lives (ADR LEG-2026-034):
// `bounded gates` reads it for its command line and the pi extensions read it for
// their tool roster. The agreement tests below are therefore tautological by
// construction — and kept, because they are what fails the day someone
// hand-wires a tool again.

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
}

/** Minimal ExtensionAPI stub: records the tools an extension registers. */
function registeredTools(install: (pi: never) => void): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(spec: RegisteredTool) {
      tools.push(spec);
    },
    on() {
      /* extensions may install hooks; irrelevant here */
    },
  };
  install(pi as never);
  return tools;
}

describe("the registry is well-formed", () => {
  test("every entry passes the runtime shape check the CLI applies", () => {
    for (const gate of gates) expect(isGateCommand(gate), gate.name).toBe(true);
  });

  test("names are unique and kebab-case", () => {
    const names = gates.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  test("tool names are unique and snake_case", () => {
    const tools = gates.flatMap((g) => (g.tool === undefined ? [] : [g.tool]));
    expect(new Set(tools).size).toBe(tools.length);
    for (const tool of tools) expect(tool).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  test("flags are kebab-case, unique per gate, and only a valued flag repeats", () => {
    for (const gate of gates) {
      const names = gate.flags.map((f) => f.name);
      expect(new Set(names).size, gate.name).toBe(names.length);
      for (const flag of gate.flags) {
        expect(flag.name, gate.name).toMatch(/^[a-z]+(-[a-z]+)*$/);
        expect(flag.description.trim(), `${gate.name} --${flag.name}`).not.toBe("");
        if (flag.repeatable) expect(flag.kind, `${gate.name} --${flag.name}`).not.toBe("boolean");
      }
      // The CLI's own flags must never collide with a gate's.
      for (const reserved of ["json", "help", "list"]) expect(names, gate.name).not.toContain(reserved);
    }
  });

  // A tool parameter is a JavaScript-friendly name; the CLI flag is kebab-case.
  test("a tool parameter name is camelCase and unique per gate", () => {
    for (const gate of gates) {
      const params = toolFlags(gate).map(paramName);
      expect(new Set(params).size, gate.name).toBe(params.length);
      for (const param of params) expect(param, gate.name).toMatch(/^[a-z][A-Za-z]*$/);
      expect(params, gate.name).not.toContain("cwd");
    }
  });

  // The model reads the schema, not the flag: a json flag a tool exposes must
  // carry one, or the model would be handed `unknown` where it used to read
  // the findings' shape.
  test("every json flag a tool exposes carries its JSON Schema", () => {
    for (const gate of gates) {
      for (const flag of toolFlags(gate)) {
        if (flag.kind === "json") expect(flag.jsonSchema, `${gate.name} --${flag.name}`).toBeDefined();
      }
    }
  });

  // The help shows a json flag's example (issue #48): it must be a payload
  // the gate accepts, or the help teaches the wrong shape.
  test("every json flag's example is valid JSON, and a findings example passes parseFindings", () => {
    for (const gate of gates) {
      for (const flag of toolFlags(gate)) {
        if (flag.kind !== "json") continue;
        const where = `${gate.name} --${flag.name}`;
        expect(flag.example, where).toBeDefined();
        const example: unknown = JSON.parse(flag.example!);
        if (flag.name === "findings") expect(parseFindings(example).ok, where).toBe(true);
      }
    }
  });
});

// mutation-score's budget is the host's command deadline less a margin for
// releasing what it started (ADR LEG-2026-070): the larger of 15% and 15 s.
describe("mutation-score's time budget", () => {
  test("is the host's deadline less the larger of 15% and 15 s, and none without a deadline", () => {
    expect(mutationBudgetMs(undefined)).toBeUndefined();
    expect(mutationBudgetMs(600_000)).toBe(510_000);
    expect(mutationBudgetMs(120_000)).toBe(102_000);
    expect(mutationBudgetMs(60_000)).toBe(45_000);
    expect(mutationBudgetMs(10_000)).toBe(0);
  });

  test("the deadline a budget error asks for buys at least that budget", () => {
    for (const budget of [1, 20_000, 85_000, 120_000, 500_000]) {
      expect(mutationBudgetMs(deadlineForBudgetMs(budget))!).toBeGreaterThanOrEqual(budget);
      expect(mutationBudgetMs(deadlineForBudgetMs(budget) - 1)!).toBeLessThan(budget);
    }
  });
});

describe("what the command line takes and a tool does not", () => {
  // `--findings-file` exists for a shell line too short for the payload; a
  // model passes findings inline. `--role` lets a person at a shell scope a
  // typecheck; a role's tool scopes by the session binding and offers no way
  // to claim another. Neither may ever surface as a tool parameter.
  test("every cliOnly flag is absent from the tool-parameter view", () => {
    const cliOnly = gates.flatMap((g) => g.flags.filter((f) => f.cliOnly === true).map((f) => [g, f] as const));
    expect(cliOnly.map(([g, f]) => `${g.name} --${f.name}`).sort()).toEqual([
      "record-design-review --findings-file",
      "sign-off --findings-file",
      "typecheck --role",
    ]);
    for (const [gate, flag] of cliOnly) {
      const params = Object.keys(toolParams(gate).properties);
      expect(params, `${gate.name} --${flag.name}`).not.toContain(flag.name);
      expect(params, `${gate.name} --${flag.name}`).not.toContain(paramName(flag));
    }
  });

  // Freezing is design_gate's step (ADR LEG-2026-019). A `--write` here would be a
  // second way to freeze, and a registry entry is exactly "what a role may
  // run" — so check-drift verifies and nothing else, from a shell too.
  test("check-drift has no flags: it verifies, it never freezes", () => {
    const drift = gates.find((g) => g.name === "check-drift");
    expect(drift?.flags).toEqual([]);
  });
});

describe("the registry and the path policy agree", () => {
  // ARTIFACT_GATE_TOOLS is the path policy's list of every pi tool that is an
  // artifact gate (ADR LEG-2026-034); `sleep` is a WAIT, not a gate, and is not in
  // it. The registry's tool-bearing entries must be that list exactly.
  test("the tool-bearing entries are exactly ARTIFACT_GATE_TOOLS", () => {
    const tools = gates.flatMap((g) => (g.tool === undefined ? [] : [g.tool])).sort();
    expect(tools).toEqual([...ARTIFACT_GATE_TOOLS].sort());
  });

  // A step of design_gate (ADR LEG-2026-019) and the check the delivered project
  // runs on its own: reachable from a shell, never offered to a role.
  test("the CLI-only entries are handoff-publish, scaffold and surface-check", () => {
    const cliOnly = gates.filter((g) => g.tool === undefined).map((g) => g.name).sort();
    expect(cliOnly).toEqual(["handoff-publish", "scaffold", "surface-check"]);
  });
});

describe("the registry and the extensions say the same thing", () => {
  const registered = [...registeredTools(installArchitectTools), ...registeredTools(installDevTools)];
  // What the extensions register that is NOT an artifact gate (sleep, git,
  // remove): derived from the policy's list, never restated.
  const isGate = (name: string): boolean => ARTIFACT_GATE_TOOLS.includes(name);

  test("every gate tool the extensions register has a registry entry", () => {
    for (const tool of registered) {
      if (!isGate(tool.name)) continue;
      expect(gates.find((g) => g.tool === tool.name), `${tool.name} has no registry entry`).toBeDefined();
    }
  });
});

// The host supplies the role (ADR LEG-2026-034). The typecheck entry used to
// resolve it itself with `sessionRole(cwd)` — against the TARGET, so a
// `typecheck src` in a bound session found no role file and answered
// unscoped (Run 15). It now reads `args.role` and nothing else.
describe("typecheck takes its role from the host", () => {
  const projects: TempProject[] = [];
  afterAll(() => projects.forEach((p) => p.cleanup()));

  test("the registry never imports the session-role resolver", () => {
    const source = readFileSync(join(import.meta.dirname, "gates.ts"), "utf8");
    expect(source).not.toMatch(/path-gate\.ts/);
    expect(source).not.toMatch(/sessionRole/);
  });

  test("run with no role is unscoped, even with a role file in the target", async () => {
    const p = makeTempProject(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
          include: ["src"],
        }),
        "src/a.ts": 'export const x: number = "s";\n',
        ".bounded/dev-stage-role": "builder\n",
      },
      { prefix: "gates-typecheck-", nodeModules: true },
    );
    projects.push(p);
    const typecheck = gates.find((g) => g.name === "typecheck");
    expect(typecheck).toBeDefined();
    const result = await typecheck!.run(p.dir, {});
    expect(result.code).toBe(1);
    expect(result.detail).toMatchObject({ ok: false, errorCount: 1 });
    expect(result.detail["scoped"]).toBeUndefined();
    const scoped = await typecheck!.run(p.dir, { role: "builder" });
    expect(scoped.detail).toMatchObject({ scoped: true });
  });
});

// The leftover-restore wrapper (ADR LEG-2026-070) keeps every field of the gate it
// wraps: the board moves on the milestones (ADR LEG-2026-066).
describe("the wrapped gates keep their board milestones", () => {
  test("design-gate, handoff-publish and deliver", () => {
    const milestones = Object.fromEntries(gates.filter((g) => g.milestone !== undefined).map((g) => [g.name, g.milestone]));
    expect(milestones).toEqual({ "design-gate": "design-frozen", "handoff-publish": "handoff-published", deliver: "delivered" });
  });
});

// Long gates run as background jobs on a host with a command time limit
// (ADR LEG-2026-073): the registry says which, and how each one is prepared.
describe("background jobs", () => {
  const projects: TempProject[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });
  afterAll(() => projects.forEach((p) => p.cleanup()));

  test("exactly deliver, green-gate, red-gate, run-tests and mutation-score run as jobs", () => {
    const long = Object.fromEntries(gates.filter((g) => g.longRunning !== undefined).map((g) => [g.name, g.longRunning]));
    expect(long).toEqual({
      deliver: "writes-tree",
      "green-gate": "reads-tree",
      "red-gate": "reads-tree",
      "run-tests": "reads-tree",
      "mutation-score": "reads-tree",
    });
  });

  test("every ts gate restores a mutation leftover in prepare, before its run", async () => {
    for (const gate of gates) expect(typeof gate.prepare, gate.name).toBe("function");
    const ORIGINAL = "export const a = 1;\n";
    const MUTATED = "export const a = 2;\n";
    const p = makeTempProject({ "src/a.ts": MUTATED }, { prefix: "gates-prepare-" });
    projects.push(p);
    const leave = (): void => {
      writeFileSync(join(p.dir, "src/a.ts"), MUTATED);
      writeJournal(p.dir, { file: "src/a.ts", mutation: "1 → 2", original: Buffer.from(ORIGINAL), mutated: Buffer.from(MUTATED) });
    };
    const checkDrift = gates.find((g) => g.name === "check-drift")!;

    // The owner is gone (this process holds no measurement): restored, nothing to say.
    leave();
    expect(await checkDrift.prepare!(p.dir)).toBeUndefined();
    expect(readFileSync(join(p.dir, "src/a.ts"), "utf8")).toBe(ORIGINAL);

    // The owner still runs: the tree holds its mutant right now.
    leave();
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(owner);
    const journalPath = join(p.dir, ".bounded/mutation-score/journal.json");
    writeFileSync(journalPath, JSON.stringify({ ...JSON.parse(readFileSync(journalPath, "utf8")), pid: owner.pid }));
    const blocked = await checkDrift.prepare!(p.dir);
    expect(blocked).toMatchObject({ code: 1, verdict: "block" });
    expect(readFileSync(join(p.dir, "src/a.ts"), "utf8")).toBe(MUTATED);
  });

  test("mutation-score's budget remedy inside a job names no command timeout", async () => {
    const p = makeTempProject({
      "package.json": JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "bun test" } }),
      "contexts/pm/src/money.ts": "export function f(x: number): boolean { if (x < 0) return false; return x === 1; }\n",
    }, { prefix: "gates-mutation-budget-", packs: ["ts", "ts-hexagonal"] });
    projects.push(p);
    vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", "16000");
    vi.stubEnv("BOUNDED_JOB_DIR", join(p.dir, ".bounded/jobs/gate-mutation-score"));
    const result = await gates.find((g) => g.name === "mutation-score")!.run(p.dir, {});
    expect(result.code).toBe(2);
    const text = result.lines.join("\n");
    expect(text).not.toMatch(/timeout of at least/);
    expect(text).toMatch(/smaller --timeout-ms/);
  });

  // Re-review: running alone and a tree that must not change are two properties.
  test("deliver and mutation-score run alone; only deliver may change the tree it is judged on", () => {
    const alone = gates.filter((g) => g.exclusive === true).map((g) => g.name).sort();
    expect(alone).toEqual(["deliver", "mutation-score"]);
    expect(gates.find((g) => g.name === "mutation-score")?.longRunning).toBe("reads-tree");
    expect(gates.find((g) => g.name === "deliver")?.longRunning).toBe("writes-tree");
  });
});
