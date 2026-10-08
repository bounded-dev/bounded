import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { discoverGates, main } from "../../../../src/gates-cli.ts";
import { readGuardLog } from "../../../../src/guard-log.ts";
import { writeFakeJobPack } from "../../../../test/fixtures/fake-job-pack.ts";
import type { GateArgs, GateCommand } from "../../../../src/gate-command.ts";
import type { GateResult } from "../../../../src/gate-result.ts";
import { CWD_DESCRIPTION, gateArgsFrom, hostArgs, registerGateTools, toolParams } from "./gate-tools.ts";

// The registry says what a gate IS; this module says what a pi tool made from
// it looks like. Both directions are pinned here with a fake gate, because the
// real ones spawn tsc, vitest or eslint — and because what matters is the
// mapping, not any one gate: a flag kind that round-trips wrongly would
// mis-invoke every gate that uses it.

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly details?: Record<string, unknown>;
}

interface RecordedTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: string[];
  readonly parameters: { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] };
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: () => void,
    ctx: { cwd: string },
  ): Promise<ToolResult>;
}

/** Minimal ExtensionAPI stub: records what registerGateTools registers. */
function registered(gates: readonly GateCommand[], tools: ReadonlySet<string>, packsDir?: string): Map<string, RecordedTool> {
  const recorded = new Map<string, RecordedTool>();
  const pi = {
    registerTool(spec: RecordedTool) {
      recorded.set(spec.name, spec);
    },
  };
  registerGateTools(pi as never, gates, tools, packsDir);
  return recorded;
}

/** The one registered tool a test drives, or a failure naming it. */
function one(gates: readonly GateCommand[], tools: ReadonlySet<string>, name: string, packsDir?: string): RecordedTool {
  const tool = registered(gates, tools, packsDir).get(name);
  if (tool === undefined) throw new Error(`'${name}' was not registered`);
  return tool;
}

function asJson(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x));
}

const ITEM_SCHEMA = { type: "array", items: { type: "object" }, description: "the items" } as const;

/** One flag of every kind, plus the two host-facing markers. */
const EVERY_KIND: GateCommand = {
  name: "every-kind",
  tool: "every_kind",
  description: "A gate with one flag of every kind.",
  flags: [
    { name: "verbose", kind: "boolean", description: "a boolean" },
    { name: "label", kind: "string", description: "a string" },
    { name: "pattern", kind: "string", repeatable: true, param: "patterns", description: "strings" },
    { name: "max-mutants", kind: "number", param: "maxMutants", description: "a number" },
    { name: "findings", kind: "json", required: true, jsonSchema: ITEM_SCHEMA, description: "json with a schema" },
    { name: "extra", kind: "json", description: "json without a schema" },
    { name: "findings-file", kind: "string", cliOnly: true, description: "cli only" },
  ],
  promptSnippet: "One of each.",
  promptGuidelines: ["Use it."],
  async run(cwd, args): Promise<GateResult> {
    return { code: 0, verdict: "pass", summary: cwd, lines: [JSON.stringify(args)], detail: {} };
  },
};

describe("toolParams", () => {
  const params = toolParams(EVERY_KIND);
  const props = asJson(params.properties);

  test("one parameter per non-cliOnly flag, named by `param` when given, plus cwd", () => {
    expect(Object.keys(params.properties).sort()).toEqual(
      ["cwd", "extra", "findings", "label", "maxMutants", "patterns", "verbose"].sort(),
    );
  });

  test("each kind becomes the matching schema, described by the flag", () => {
    expect(props).toMatchObject({
      verbose: { type: "boolean", description: "a boolean" },
      label: { type: "string", description: "a string" },
      patterns: { type: "array", items: { type: "string" }, description: "strings" },
      maxMutants: { type: "number", description: "a number" },
      cwd: { type: "string", description: CWD_DESCRIPTION },
    });
  });

  test("a json flag exposes its JSON Schema verbatim, its own description winning", () => {
    expect(asJson(params.properties["findings"])).toEqual(ITEM_SCHEMA);
  });

  test("a json flag without a schema is unknown, described by the flag", () => {
    expect(asJson(params.properties["extra"])).toEqual({ description: "json without a schema" });
  });

  test("only a `required` flag is required; cwd never is", () => {
    expect(params.required).toEqual(["findings"]);
  });
});

describe("gateArgsFrom", () => {
  test("maps every parameter back to its FLAG name and drops what was not given", () => {
    const args: GateArgs = gateArgsFrom(EVERY_KIND, {
      verbose: true,
      patterns: ["a", "b"],
      maxMutants: 5,
      findings: [],
      cwd: "ignored — not a flag",
    });
    expect(args).toEqual({ verbose: true, pattern: ["a", "b"], "max-mutants": 5, findings: [] });
  });

  test("a cliOnly flag cannot be smuggled in as a parameter", () => {
    expect(gateArgsFrom(EVERY_KIND, { "findings-file": "x", findingsFile: "x" })).toEqual({});
  });

  test("round-trips through the tool schema's own names", () => {
    const given: Record<string, unknown> = { label: "L", extra: { any: 1 }, findings: [{ a: 1 }] };
    for (const name of Object.keys(given)) expect(Object.keys(toolParams(EVERY_KIND).properties)).toContain(name);
    expect(gateArgsFrom(EVERY_KIND, given)).toEqual(given);
  });
});

describe("registerGateTools", () => {
  const OTHER: GateCommand = {
    name: "other",
    tool: "other",
    description: "Not in the set.",
    flags: [],
    async run(): Promise<GateResult> {
      return { code: 1, verdict: "block", summary: "no", lines: ["other: no"], detail: {} };
    },
  };
  const CLI_ONLY: GateCommand = {
    name: "cli-only",
    description: "No tool at all.",
    flags: [],
    async run(): Promise<GateResult> {
      return { code: 0, verdict: "pass", summary: "", lines: [], detail: {} };
    },
  };

  test("registers exactly the entries whose tool is in the set", () => {
    const tools = registered([EVERY_KIND, OTHER, CLI_ONLY], new Set(["every_kind", "cli-only", "cli_only"]));
    expect([...tools.keys()]).toEqual(["every_kind"]);
  });

  test("carries the registry's description, snippet and guidelines, and a label from the name", () => {
    const tool = one([EVERY_KIND], new Set(["every_kind"]), "every_kind");
    expect(tool).toMatchObject({
      label: "Every Kind",
      description: EVERY_KIND.description,
      promptSnippet: "One of each.",
      promptGuidelines: ["Use it."],
    });
    expect(asJson(tool.parameters)).toEqual(asJson(toolParams(EVERY_KIND)));
  });

  test("execute resolves cwd against the session, runs the gate with mapped args, and prints lines + verdict", async () => {
    const tool = one([EVERY_KIND], new Set(["every_kind"]), "every_kind");
    const res = await tool.execute("c1", { patterns: ["x"], findings: [], cwd: "sub" }, undefined, () => {}, {
      cwd: "/session",
    });
    expect(res.content[0]?.text).toBe(
      [JSON.stringify({ pattern: ["x"], findings: [] }), "every-kind: PASS"].join("\n"),
    );
    expect(res.details).toEqual({ code: 0, ok: true });
  });

  test("details.ok follows the code, and the verdict line uses the CLI name and wording", async () => {
    const verdicts: [GateResult["code"], GateResult["verdict"], string][] = [
      [1, "block", "other: BLOCK"],
      [2, "error", "other: ERROR (misuse — the gate could not run)"],
    ];
    for (const [code, verdict, line] of verdicts) {
      const gate: GateCommand = {
        ...OTHER,
        async run(): Promise<GateResult> {
          return { code, verdict, summary: "", lines: ["first"], detail: {} };
        },
      };
      const tool = one([gate], new Set(["other"]), "other");
      const res = await tool.execute("c1", {}, undefined, () => {}, { cwd: "/session" });
      expect(res.content[0]?.text).toBe(`first\n${line}`);
      expect(res.details).toEqual({ code, ok: false });
    }
  });

  test("a call cancelled while the gate ran reports the cancellation, not a verdict", async () => {
    const tool = one([OTHER], new Set(["other"]), "other");
    const res = await tool.execute("c1", {}, AbortSignal.abort(), () => {}, { cwd: "/session" });
    expect(res.content[0]?.text).toBe("other: cancelled");
    expect(res.details).toEqual({});
  });
});

// The host supplies the role (ADR 2026-029): a gate with a cliOnly `role`
// flag is handed the SESSION's binding — the one the path gate acts on — and
// resolved from the session cwd. Run 15's hole was resolving it from the
// TARGET: `typecheck({cwd: "src"})` found no role file under `src/` and
// answered with the unscoped project diagnostics, test paths and all.
describe("the session role is the host's to supply", () => {
  const SCOPED: GateCommand = {
    name: "scoped",
    tool: "scoped",
    description: "A gate that scopes by role.",
    flags: [{ name: "role", kind: "string", cliOnly: true, description: "the role" }],
    async run(cwd, args): Promise<GateResult> {
      return { code: 0, verdict: "pass", summary: cwd, lines: [JSON.stringify(args)], detail: {} };
    },
  };
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  /** A session dir bound to `builder` by role file, with a bare `sub/` under it. */
  function session(): string {
    const dir = mkdtempSync(join(tmpdir(), "gate-tools-role-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".bounded"), { recursive: true });
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, ".bounded", "dev-stage-role"), "builder\n");
    return dir;
  }

  test("hostArgs names the session role only for a gate with a cliOnly `role` flag", () => {
    const dir = session();
    expect(hostArgs(SCOPED, dir)).toEqual({ role: "builder" });
    expect(hostArgs(EVERY_KIND, dir)).toEqual({});
    expect(hostArgs(SCOPED, join(dir, "sub"))).toEqual({});
  });

  test("execute hands the gate the role from ctx.cwd, not from the target cwd", async () => {
    const dir = session();
    const tool = one([SCOPED], new Set(["scoped"]), "scoped");
    const res = await tool.execute("c1", { cwd: "sub" }, undefined, () => {}, { cwd: dir });
    expect(res.content[0]?.text).toBe([JSON.stringify({ role: "builder" }), "scoped: PASS"].join("\n"));
  });

  test("a caller cannot pass `role` as a parameter — the host's wins, and none means unscoped", async () => {
    const dir = session();
    const tool = one([SCOPED], new Set(["scoped"]), "scoped");
    const claimed = await tool.execute("c1", { role: "architect" }, undefined, () => {}, { cwd: dir });
    expect(claimed.content[0]?.text).toContain(JSON.stringify({ role: "builder" }));
    const unbound = await tool.execute("c2", {}, undefined, () => {}, { cwd: join(dir, "sub") });
    expect(unbound.content[0]?.text).toBe(["{}", "scoped: PASS"].join("\n"));
  });
});

// Long gates run as background jobs under a host deadline (ADR 2026-073). pi
// gives no deadline, so its call runs a long gate in the call, after first
// collecting any job a deadline-bound call (Claude Code, a shell) started.
describe("background jobs through the pi tools", () => {
  let root = "";
  let project = "";
  let packs = "";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-gate-tools-jobs-")));
    project = join(root, "project");
    packs = join(root, "packs");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "a.txt"), "a\n");
    writeFakeJobPack(packs);
    vi.stubEnv("BOUNDED_GUARD_LOG", "");
    vi.stubEnv("BOUNDED_HOST", undefined);
    vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const e of readGuardLog(project)) {
      const pid = Number(e.detail?.["pid"]);
      if (e.detail?.["kind"] === "job-started" && Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const runs = (): string[] => {
    const path = join(root, "runs.log");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
  };

  test("pi collects a job a deadline-bound call started", async () => {
    vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", "16000");
    const io = { out: () => {}, err: () => {} };
    expect(await main(["slow", "--ms", "2000"], project, io, undefined, packs)).toBe(3);
    vi.stubEnv("BOUNDED_COMMAND_TIMEOUT_MS", undefined);
    const tool = one(await discoverGates(packs), new Set(["slow_gate"]), "slow_gate", packs);
    const res = await tool.execute("c1", { ms: 2000 }, undefined, () => {}, { cwd: project });
    expect(res.content[0]?.text.endsWith("slow: PASS")).toBe(true);
    expect(res.details).toMatchObject({ code: 0 });
    expect(runs()).toEqual(["slow"]);
  }, 20_000);

  test("a long gate's tool description says to call again on RUNNING", async () => {
    const tools = registered(await discoverGates(packs), new Set(["slow_gate", "quick_gate"]), packs);
    expect(tools.get("slow_gate")?.description).toContain("RUNNING");
    expect(tools.get("slow_gate")?.description).toContain("call it again");
    expect(tools.get("quick_gate")?.description).not.toContain("RUNNING");
  });
});
