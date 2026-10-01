// The design gate's scaffold step on the hexagonal monorepo (ADRs 2026-060,
// 2026-061): the composed emitters write the mechanical files, the project's
// config follows the design's workspaces, and nothing a role wrote is lost.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readGuardLog } from "../../../src/guard-log.ts";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import {
  configDrift,
  configDriftBlock,
  isDesignDerivedDrift,
  syncDesignConfig,
  syncProjectConfig,
  type SetupRun,
} from "./project-config.ts";
import { EMITTED_RECORD, runScaffold, untouchedSkeletons } from "./scaffold-project.ts";
import { exampleProject, fakeLockfileMaker, type Fixture, fixtureHarness } from "./testdata/workspace-fixture.ts";

const cleanups: (() => void)[] = [];
afterAll(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const ROOT = "contexts/money/src";
const CURRENCY = `${ROOT}/domain/currencies/currency.contract.ts`;
const CURRENCY_IMPL = `${ROOT}/domain/currencies/currency.ts`;
const CURRENCY_LAWS = `${ROOT}/domain/currencies/currency.laws.test.ts`;
const TICKER = `${ROOT}/domain/tickers/ticker.contract.ts`;
const TICKER_LAWS = `${ROOT}/domain/tickers/ticker.laws.test.ts`;

const concept = (name: string, examples: readonly string[]): string => `import type { Result } from "../shared/result.ts";

/**
 * ${name}: an uppercase code.
${examples.map((e) => ` * @accepts "${e}"`).join("\n")}
 */
export interface ${name} {
  readonly __brand: "${name}";
  readonly value: string;
  equals(other: ${name}): boolean;
  toJSON(): string;
}

export interface ${name}Factory {
  parse(raw: unknown): Result<${name}>;
}
`;

function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/** A hexagonal project whose config the packs did not generate: the emitters
 *  run, and the config step has nothing to follow. */
function project(files: Record<string, string> = { [CURRENCY]: concept("Currency", ["USD", "EUR"]) }): string {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-project-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeProjectPacks(dir, ["ts", "ts-hexagonal"]);
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}

const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), "utf8");

describe("runScaffold: the emitters over the design", () => {
  test("writes the generated files and the fresh skeletons, logs a pass, records what it generated", () => {
    const dir = project();
    const r = runScaffold(dir);
    expect(r.code, r.lines.join("\n")).toBe(0);
    for (const rel of [CURRENCY_IMPL, CURRENCY_LAWS, `${ROOT}/domain/index.ts`, `${ROOT}/domain/shared/result.ts`, `${ROOT}/domain/shared/errors.ts`]) {
      expect(existsSync(join(dir, rel)), rel).toBe(true);
    }
    expect(r.lines).toContain(`scaffold: wrote ${CURRENCY_IMPL} (skeleton, domain-concepts)`);
    expect(read(dir, CURRENCY_IMPL)).toContain('new NotImplementedError("Currency.parse")');
    expect(r.lines.at(-1)).toMatch(/^scaffold: OK — \d+ emitted files: \d+ written, 0 skeletons kept$/);
    expect(readGuardLog(dir).at(-1)).toMatchObject({ guard: "scaffold", verdict: "pass" });
    const record = JSON.parse(read(dir, EMITTED_RECORD)) as string[];
    expect(record).toContain(CURRENCY_LAWS);
    expect(record).not.toContain(CURRENCY_IMPL);
  });

  test("a skeleton is the builder's once written: a re-run keeps it byte-identical", () => {
    const dir = project();
    expect(runScaffold(dir).code).toBe(0);
    const built = read(dir, CURRENCY_IMPL).replace('throw new NotImplementedError("Currency.parse");', 'return { ok: false, error: "todo" };');
    writeFileSync(join(dir, CURRENCY_IMPL), built);
    const again = runScaffold(dir);
    expect(again.code).toBe(0);
    expect(read(dir, CURRENCY_IMPL)).toBe(built);
    expect(again.lines.at(-1)).toMatch(/1 skeleton kept/);
  });

  test("a generated file is rewritten whenever it differs; an unchanged one is not reported", () => {
    const dir = project();
    expect(runScaffold(dir).code).toBe(0);
    const laws = read(dir, CURRENCY_LAWS);
    writeFileSync(join(dir, CURRENCY_LAWS), "// tampered\n");
    const again = runScaffold(dir);
    expect(again.lines).toContain(`scaffold: wrote ${CURRENCY_LAWS} (generated, domain-concepts)`);
    expect(again.lines.filter((l) => l.startsWith("scaffold: wrote"))).toHaveLength(1);
    expect(read(dir, CURRENCY_LAWS)).toBe(laws);
  });

  test("a generated file the design no longer produces is pruned, and its empty directory goes too", () => {
    const dir = project({ [CURRENCY]: concept("Currency", ["USD", "EUR"]), [TICKER]: concept("Ticker", ["AAPL", "MSFT"]) });
    expect(runScaffold(dir).code).toBe(0);
    expect(existsSync(join(dir, TICKER_LAWS))).toBe(true);
    rmSync(join(dir, TICKER));
    rmSync(join(dir, `${ROOT}/domain/tickers/ticker.ts`));
    const again = runScaffold(dir);
    expect(again.code).toBe(0);
    expect(again.lines).toContain(`scaffold: pruned ${TICKER_LAWS} — the design no longer produces it`);
    expect(existsSync(join(dir, `${ROOT}/domain/tickers`))).toBe(false);
    expect(existsSync(join(dir, CURRENCY_LAWS))).toBe(true);
    expect((readGuardLog(dir).at(-1)?.detail as { pruned?: unknown }).pruned).toEqual([TICKER_LAWS]);
    // Idempotent: nothing left to say.
    expect(runScaffold(dir).lines.some((l) => l.includes("pruned"))).toBe(false);
  });

  test("the prune removes only what this step recorded: an unrecorded file at a generated path survives", () => {
    const dir = project();
    write(dir, `${ROOT}/domain/tickers/ticker.laws.test.ts`, "// someone else's\n");
    expect(runScaffold(dir).code).toBe(0);
    expect(read(dir, TICKER_LAWS)).toBe("// someone else's\n");
  });

  test("a design an emitter refuses blocks with the emitter's words, and writes nothing", () => {
    const dir = project({ [`${ROOT}/application/money/move-money/move-money.contract.ts`]: "export interface MoveMoney {\n  execute(): Promise<void>;\n}\n" });
    const r = runScaffold(dir);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^scaffold: BLOCK — emitter '[a-z-]+': .*area 'money' must be a kebab-case plural business noun/);
    expect(existsSync(join(dir, `${ROOT}/domain`))).toBe(false);
    expect(existsSync(join(dir, EMITTED_RECORD))).toBe(false);
    expect(readGuardLog(dir).at(-1)).toMatchObject({ guard: "scaffold", verdict: "block" });
  });

  test("no contract under any source root is misuse (exit 2): silence is not a design", () => {
    const dir = project({ "src/stray.contract.ts": "export interface Stray {}\n" });
    const r = runScaffold(dir);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatch(/no contract files under any source root/);
  });

  test("an unreadable composition blocks rather than guess", () => {
    const dir = project();
    writeFileSync(join(dir, ".bounded", "composed-packs.json"), "not json\n");
    expect(runScaffold(dir).code).toBe(1);
  });
});

describe("untouchedSkeletons: what the builder has not written yet", () => {
  test("a fresh skeleton is untouched; an edited one is the builder's", () => {
    const dir = project({ [CURRENCY]: concept("Currency", ["USD", "EUR"]), [TICKER]: concept("Ticker", ["AAPL", "MSFT"]) });
    expect(runScaffold(dir).code).toBe(0);
    expect([...untouchedSkeletons(dir)].sort()).toEqual([CURRENCY_IMPL, `${ROOT}/domain/tickers/ticker.ts`]);
    writeFileSync(join(dir, CURRENCY_IMPL), read(dir, CURRENCY_IMPL) + "// built\n");
    expect([...untouchedSkeletons(dir)]).toEqual([`${ROOT}/domain/tickers/ticker.ts`]);
  });

  test("a design that cannot be emitted has no untouched skeleton", () => {
    const dir = project();
    writeFileSync(join(dir, ".bounded", "composed-packs.json"), "not json\n");
    expect(untouchedSkeletons(dir).size).toBe(0);
  });
});

// --- the design's own config (ADR 2026-061) ---------------------------------------

describe("isDesignDerivedDrift", () => {
  const roots = new Set(["contexts", "apps"]);
  test("a workspace manifest and the lockfile follow from the design", () => {
    for (const path of ["contexts/billing/package.json", "apps/web/package.json", "bun.lock", ".bounded/lockfile-fingerprint.json"]) {
      expect(isDesignDerivedDrift({ path, problem: "missing" }, roots), path).toBe(true);
    }
  });
  test("a dependency directory a dropped workspace leaves behind follows from the design", () => {
    expect(isDesignDerivedDrift({ path: "contexts/old/node_modules", problem: "x" }, roots)).toBe(true);
    expect(isDesignDerivedDrift({ path: "contexts/old/src/node_modules", problem: "x" }, roots)).toBe(false);
  });
  test("everything else is someone's edit", () => {
    for (const path of ["package.json", "tsconfig.json", "contexts/billing/src/package.json", "libs/x/package.json", "contexts/billing/tsconfig.json"]) {
      expect(isDesignDerivedDrift({ path, problem: "differs" }, roots), path).toBe(false);
    }
  });
});

describe("syncDesignConfig and the design gate's drift tolerance", () => {
  const fake = { makeLockfile: fakeLockfileMaker };

  function fixture(): Fixture {
    const f = fixtureHarness();
    cleanups.push(f.cleanup);
    return f;
  }

  /** The example's tree with its config generated, its harness linked where
   *  the setup plan reads the composed setup commands. */
  function synced(f: Fixture): string {
    const p = exampleProject(f);
    cleanups.push(p.cleanup);
    writeFileSync(join(p.project, "package.json"), '{"name":"example"}\n');
    symlinkSync(f.harness, join(p.project, ".bounded", "harness"), "dir");
    expect(syncProjectConfig(p.project, f.harness, fake).code).toBe(0);
    return p.project;
  }

  /** A setup runner that records its calls and leaves the install's probe behind. */
  function recordingSetup(calls: string[], fail?: string): SetupRun {
    return (command, args, cwd) => {
      calls.push([command, ...args].join(" "));
      if (fail !== undefined) throw new Error(fail);
      mkdirSync(join(cwd, "node_modules", ".bun"), { recursive: true });
    };
  }

  const addContext = (project: string): void =>
    write(project, "contexts/billing/src/domain/invoices/invoice.contract.ts", "export interface Invoice {}\n");

  test("config that already matches: nothing written, nothing run", () => {
    const f = fixture();
    const project = synced(f);
    const calls: string[] = [];
    expect(syncDesignConfig(project, f.harness, recordingSetup(calls), fake)).toEqual({ code: 0, lines: [], workspaces: [] });
    expect(calls).toEqual([]);
  });

  test("a context the design adds: its manifest, the apps' and the lockfile are written, then the project is installed", () => {
    const f = fixture();
    const project = synced(f);
    addContext(project);
    expect(configDriftBlock("design-gate", project, f.harness)?.code).toBe(1);
    expect(configDriftBlock("design-gate", project, f.harness, { tolerateDesignDrift: true })).toBeUndefined();
    const calls: string[] = [];
    const r = syncDesignConfig(project, f.harness, recordingSetup(calls), fake);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(r.workspaces).toEqual(expect.arrayContaining(["contexts/billing", "apps/web"]));
    expect(r.lines).toEqual(expect.arrayContaining(["wrote contexts/billing/package.json", "wrote bun.lock"]));
    expect(calls).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(configDrift(project, f.harness)).toEqual([]);
  });

  test("drift that is someone's edit is left alone, and the gate still refuses it", () => {
    const f = fixture();
    const project = synced(f);
    addContext(project);
    writeFileSync(join(project, "tsconfig.json"), "{}\n");
    const calls: string[] = [];
    expect(syncDesignConfig(project, f.harness, recordingSetup(calls), fake)).toEqual({ code: 0, lines: [], workspaces: [] });
    expect(calls).toEqual([]);
    expect(existsSync(join(project, "contexts/billing/package.json"))).toBe(false);
    expect(configDriftBlock("design-gate", project, f.harness, { tolerateDesignDrift: true })?.lines.join("\n")).toMatch(/tsconfig\.json/);
  });

  test("without the registry, it refuses clearly and says what to do", () => {
    const f = fixture();
    const project = synced(f);
    addContext(project);
    const r = syncDesignConfig(project, f.harness, recordingSetup([]), { makeLockfile: () => { throw new Error("registry unreachable"); } });
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/the design changes workspaces? .*contexts\/billing.*registry unreachable/);
    expect(r.lines.join("\n")).toMatch(/package registry \(or bun's cache\) reachable/);
    expect(existsSync(join(project, "contexts/billing/package.json"))).toBe(false);
  });

  test("an install that fails refuses too: the config is synced, the dependencies are not", () => {
    const f = fixture();
    const project = synced(f);
    addContext(project);
    const r = syncDesignConfig(project, f.harness, recordingSetup([], "network down"), fake);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/network down/);
  });

  test("a project whose config the packs did not generate has nothing to follow", () => {
    expect(syncDesignConfig(project(), undefined, recordingSetup([]))).toEqual({ code: 0, lines: [], workspaces: [] });
  });
});
