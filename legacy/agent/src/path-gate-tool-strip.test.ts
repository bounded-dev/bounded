import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import installAmbientPathGate from "../hosts/pi/extensions/path-gate.ts";
import installArchitectPathGate from "../hosts/pi/extensions/path-gate/architect.ts";
import installBuilderPathGate from "../hosts/pi/extensions/path-gate/builder.ts";
import { readGuardLog } from "./guard-log.ts";
import { NO_HOST, recordHostDeclaration } from "./host.ts";
import { planToolStrip, resetPathGateRegistry } from "./path-gate.ts";
import { FORBIDDEN_TOOLS, ROLE_TOOLS, type Role } from "./path-policy.ts";

// THE COST THIS EXISTS TO REMOVE (live architect session, 2026-09-08)
//
// The path gate refuses a role's forbidden tools, but a REFUSAL is not the
// same as not having the tool. The model still saw `bash` in its toolset, so
// it planned around it and reached for it whenever it got stuck: six
// consecutive turns spent on `bash`, plus one each on `run_tests` and the
// rest, every one of them refused.
//
// A subagent never pays this. Its frontmatter `tools:` allowlist removes the
// tool at spawn, before the model is shown anything — which is exactly why the
// refusal text calls the allowlist the primary layer. A session launched
// DIRECTLY (`.bounded/dev-stage-role` + plain `pi`, or `bounded-ticket`) has no
// frontmatter, so there the allowlist was documentation and the gate was
// paying a turn per attempt.
//
// pi's ExtensionAPI closes it: `setActiveTools()` is live from `session_start`
// onwards (the tool actions throw during extension LOAD), and it fires before
// the first provider request — and setting the active tools rebuilds the
// system prompt, so the tool leaves the prompt's tool list as well as the
// provider schema. The model is never told the tool exists.

/** Minimal ExtensionAPI stub: records handlers and the active-tool traffic. */
interface FakePi {
  readonly pi: unknown;
  /** Fire session_start as the host does, after binding. */
  start(cwd: string): void;
  /** Fire one tool_call as the host does; the gate's answer, if any. */
  call(cwd: string, toolName: string, input: Record<string, unknown>): Promise<unknown>;
  /** The tool names the model can actually see. */
  active(): string[];
  /** Every setActiveTools() call, in order. */
  readonly calls: string[][];
}

function fakePi(active: readonly string[]): FakePi {
  let current = [...active];
  const calls: string[][] = [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getActiveTools: () => [...current],
    setActiveTools(names: string[]) {
      calls.push([...names]);
      current = [...names];
    },
  };
  return {
    pi,
    start(cwd: string) {
      for (const h of handlers.get("session_start") ?? []) {
        h({ type: "session_start", reason: "startup" }, { cwd });
      }
    },
    async call(cwd: string, toolName: string, input: Record<string, unknown>) {
      let answer: unknown;
      for (const h of handlers.get("tool_call") ?? []) {
        answer = (await h({ type: "tool_call", toolName, input }, { cwd })) ?? answer;
      }
      return answer;
    },
    active: () => [...current],
    calls,
  };
}

const dirs: string[] = [];
function project(role?: Role): string {
  const dir = mkdtempSync(join(tmpdir(), "path-gate-strip-"));
  dirs.push(dir);
  if (role !== undefined) {
    mkdirSync(join(dir, ".bounded"), { recursive: true });
    writeFileSync(join(dir, ".bounded", "dev-stage-role"), `${role}\n`);
  }
  return dir;
}

beforeEach(() => {
  resetPathGateRegistry();
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A realistic toolset for a directly-launched architect: pi's builtins plus
// everything the harness's own extensions register.
const FULL_TOOLSET = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "remove",
  "typecheck",
  "run_tests",
  "record_design_review",
  "change_diff",
  "subagent",
  "git",
  "sleep",
  "mutation_score",
  "contract_purity",
  "design_gate",
  "check_drift",
  "red_gate",
  "generate_artifacts",
  "green_gate",
  "sign_off",
  "deliver",
];

// ---------------------------------------------------------------------------
// planToolStrip — the pure half
// ---------------------------------------------------------------------------

describe("planToolStrip", () => {
  test("hides exactly the role's forbidden set, and nothing else", () => {
    for (const role of ["architect", "test-writer", "builder", "reviewer"] as const) {
      const strip = planToolStrip(role, FULL_TOOLSET);
      expect(strip, `${role} holds forbidden tools, so a strip is due`).toBeDefined();
      expect([...strip!.hidden].sort()).toEqual(
        FULL_TOOLSET.filter((t) => FORBIDDEN_TOOLS[role].has(t)).sort(),
      );
      // Nothing the role is entitled to may be lost on the way.
      for (const tool of ROLE_TOOLS[role]) {
        expect(strip!.active, `${role} must keep '${tool}'`).toContain(tool);
      }
    }
  });

  test("the architect loses bash, reviewer tools and run_tests", () => {
    const strip = planToolStrip("architect", FULL_TOOLSET);
    expect([...strip!.hidden].sort()).toEqual(["bash", "change_diff", "record_design_review", "run_tests"]);
    // ...and keeps the substitutes its refusals name.
    for (const kept of ["git", "typecheck", "red_gate", "green_gate", "subagent"]) {
      expect(strip!.active).toContain(kept);
    }
  });

  test("order is preserved — a strip reorders nothing", () => {
    const strip = planToolStrip("builder", ["read", "bash", "write", "git", "run_tests"]);
    expect(strip!.active).toEqual(["read", "write", "run_tests"]);
  });

  test("an already-stripped toolset plans no strip, so no call is made", () => {
    // This is the subagent case: the frontmatter allowlist got there first.
    expect(planToolStrip("test-writer", ROLE_TOOLS["test-writer"])).toBeUndefined();
    expect(planToolStrip("builder", ["read", "write", "typecheck"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The extension wiring
// ---------------------------------------------------------------------------

describe("the strip at session start", () => {
  test("a bound architect loader hides its forbidden tools before the first turn", () => {
    const cwd = project();
    const fake = fakePi(FULL_TOOLSET);
    installArchitectPathGate(fake.pi as never);
    fake.start(cwd);

    expect(fake.calls).toHaveLength(1);
    for (const gone of ["bash", "run_tests", "record_design_review"]) {
      expect(fake.active(), `'${gone}' must not be visible to the architect`).not.toContain(gone);
    }
    expect(fake.active()).toContain("git");
    expect(fake.active()).toContain("red_gate");
  });

  test("the ambient gate strips a role bound through .bounded/dev-stage-role — the gap this closes", () => {
    // A plain `pi` in the dogfood harnessed arm: no launcher, no frontmatter,
    // and until now no strip either.
    const cwd = project("architect");
    const fake = fakePi(FULL_TOOLSET);
    installAmbientPathGate(fake.pi as never);
    fake.start(cwd);

    expect(fake.active()).not.toContain("bash");
    expect(fake.active()).not.toContain("run_tests");
  });

  test("a session with no role keeps every tool — the gate is inactive, not restrictive", () => {
    const cwd = project(); // no .bounded/dev-stage-role
    const fake = fakePi(FULL_TOOLSET);
    installAmbientPathGate(fake.pi as never);
    fake.start(cwd);

    expect(fake.calls).toHaveLength(0);
    expect(fake.active()).toEqual(FULL_TOOLSET);
  });

  test("the ambient gate stands down where a bound role claimed the process", () => {
    // The dogfood Run 6 hazard, in its toolset form: a builder subagent shares
    // its parent's project directory, so the ambient gate would read the
    // PARENT's `architect` role file and strip the child of run_tests — the one
    // tool the builder exists to use.
    const cwd = project("architect");
    const fake = fakePi(FULL_TOOLSET);
    installBuilderPathGate(fake.pi as never); // bound loader, claims the process
    installAmbientPathGate(fake.pi as never); // auto-loaded, must stand down
    fake.start(cwd);

    expect(fake.calls).toHaveLength(1); // the bound loader only
    expect(fake.active()).toContain("run_tests");
    expect(fake.active()).not.toContain("bash");
    expect(fake.active()).not.toContain("git");
  });

  test("an already-stripped subagent toolset triggers no call at all", () => {
    const cwd = project();
    const fake = fakePi(ROLE_TOOLS.builder);
    installBuilderPathGate(fake.pi as never);
    fake.start(cwd);
    expect(fake.calls).toHaveLength(0);
  });

  test("a strip is recorded in the guard log, so the tool's absence is explained", () => {
    // Without the line, "the architect never called bash" and "the architect
    // could not see bash" are indistinguishable in the transcript.
    const cwd = project();
    const fake = fakePi(FULL_TOOLSET);
    installArchitectPathGate(fake.pi as never);
    fake.start(cwd);

    const events = readGuardLog(cwd).filter((e) => e.detail?.["kind"] === "tool-strip");
    expect(events).toHaveLength(1);
    expect(events[0]!.guard).toBe("path-gate");
    expect(events[0]!.verdict).toBe("pass");
    expect(events[0]!.summary).toBe("hid bash, run_tests, record_design_review, change_diff from architect");
    expect(events[0]!.detail).toMatchObject({ role: "architect" });
  });

  test("a bound session declares its host — pi enforces all four constraints (ADR LEG-2026-034)", () => {
    const cwd = project();
    const fake = fakePi(FULL_TOOLSET);
    installArchitectPathGate(fake.pi as never);
    fake.start(cwd);

    const hosts = readGuardLog(cwd).filter((e) => e.guard === "host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.summary).toBe("host pi: enforces tool-strip, path-gate, phase-gate, scoped-views");
    expect(hosts[0]!.detail).toMatchObject({ kind: "host", host: "pi", unenforced: [] });
    // Declared BEFORE the strip is recorded: the host line explains the lines after it.
    const order = readGuardLog(cwd).map((e) => e.guard);
    expect(order.indexOf("host")).toBeLessThan(order.indexOf("path-gate"));
  });

  test("the host line is re-declared on every gated call, so a bare bounded gates cannot leave it lying", async () => {
    // A `bounded gates` from another terminal writes `host none` mid-session; every
    // pi event after it would sit under a line saying nothing was enforced.
    const cwd = project();
    const fake = fakePi(FULL_TOOLSET);
    installArchitectPathGate(fake.pi as never);
    fake.start(cwd);
    const hostLines = () => readGuardLog(cwd).filter((e) => e.guard === "host").map((e) => e.detail?.["host"]);
    expect(hostLines()).toEqual(["pi"]);

    recordHostDeclaration(cwd, NO_HOST);
    expect(hostLines()).toEqual(["pi", "none"]);

    const answer = await fake.call(cwd, "read", { path: join(cwd, "src", "money", "money.contract.ts") });
    expect(answer).toBeUndefined(); // the architect may read a contract: the call passed
    expect(hostLines()).toEqual(["pi", "none", "pi"]);
    expect(readGuardLog(cwd).at(-1)?.summary).toBe("host pi: enforces tool-strip, path-gate, phase-gate, scoped-views");

    // Deduped: a second call with the host line already current writes nothing.
    await fake.call(cwd, "read", { path: join(cwd, "src", "money", "money.contract.ts") });
    expect(hostLines()).toEqual(["pi", "none", "pi"]);
  });

  test("a host that cannot strip still starts, and is still gated", () => {
    // The strip is defence in depth over the tool_call refusals. If the host's
    // tool actions are unavailable, the session must come up gated rather than
    // fail to come up at all.
    const cwd = project();
    const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
    const pi = {
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        if (event === "session_start") handlers.push(handler);
      },
      getActiveTools(): string[] {
        throw new Error("Extension runtime not initialized");
      },
      setActiveTools() {
        throw new Error("Extension runtime not initialized");
      },
    };
    installArchitectPathGate(pi as never);
    expect(() => {
      for (const h of handlers) h({ type: "session_start", reason: "startup" }, { cwd });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The launcher's own layer
// ---------------------------------------------------------------------------

// `--exclude-tools` is the STRONGER of the two layers: it drops the tool from
// the session's registry entirely, where setActiveTools only deactivates it.
// bounded-ticket carries the architect's list literally, because a bash launcher
// cannot import TypeScript — so the two are pinned equal here instead. Without
// this, adding a tool to FORBIDDEN_TOOLS.architect would silently leave the
// launcher one tool behind.
describe("bounded-ticket's --exclude-tools list", () => {
  test("names exactly the architect's forbidden tools", () => {
    const script = readFileSync(
      join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "bounded-ticket"),
      "utf8",
    );
    const m = /--exclude-tools (\S+)/.exec(script);
    expect(m, "bounded-ticket no longer passes --exclude-tools").not.toBeNull();
    expect(m![1]!.split(",").sort()).toEqual([...FORBIDDEN_TOOLS.architect].sort());
  });
});
