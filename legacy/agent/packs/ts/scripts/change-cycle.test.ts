import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import type { TempProject } from "../../../test/support/temp-project.ts";
import { delivered, LOG, logLines, makeLeadProject, prepared, runStart } from "../../../test/support/lead-project.ts";
import { adoptProject, captureChangeBaseline, readChangeBaseline, BASELINE_PATH } from "./change-baseline.ts";
import { designDiff, FIRST_RUN_LINE } from "./change-diff.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "change-cycle-"));
  dirs.push(dir);
  return dir;
}
function trackedProject(): string {
  const dir = temp();
  mkdirSync(join(dir, "contexts/lending/src/domain/items"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".bounded/\nnode_modules/\n");
  writeFileSync(join(dir, "spec.md"), "# Design\n\nA loan has one borrower.\n");
  writeFileSync(join(dir, "contexts/lending/src/domain/items/item.contract.ts"), "export declare function returnItem(): void;\n");
  writeFileSync(join(dir, "CONTEXT.md"), "# Terms\n\nBorrower means the person holding an item.\n");
  mkdirSync(join(dir, "ADRs"));
  writeFileSync(join(dir, "ADRs/LEG-2026-001-loans.md"), "# Loan decision\n\nReturns are explicit.\n");
  // Contracts are the files under the composed source roots (ADR LEG-2026-056).
  writeProjectPacks(dir, ["ts", "ts-hexagonal"]);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "baseline"]);
  return dir;
}
/** A clean, implemented hexagonal project (TN-26-012) adoption checks: one
 *  domain concept, its implementation, and the config the gates read. */
const RESULT = "export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };\n";
const TICKS_CONTRACT = `import type { Result } from "../shared/result.ts";

/**
 * A number of clock ticks: a whole number, zero or more.
 * @accepts 0
 * @accepts 3
 */
export interface TickCount {
  readonly __brand: "TickCount";
  readonly value: number;
  equals(other: TickCount): boolean;
  toJSON(): number;
}

export interface TickCountFactory {
  parse(raw: unknown): Result<TickCount>;
}
`;
const TICKS_IMPL = `import { z } from "zod";
import type { Result } from "../shared/result.ts";
import type * as Contract from "./tick-count.contract.ts";

const schema = z.number().int().min(0, "Tick count is a whole number, zero or more");

class TickCountImpl implements Contract.TickCount {
  declare readonly __brand: "TickCount";
  private constructor(readonly value: number) {}

  static parse(raw: unknown): Result<Contract.TickCount> {
    const result = schema.safeParse(raw);
    return result.success
      ? { ok: true, value: new TickCountImpl(result.data) }
      : { ok: false, error: result.error.issues[0]?.message ?? "Invalid tick count" };
  }

  equals(other: Contract.TickCount): boolean {
    return this.value === other.value;
  }

  toJSON(): number {
    return this.value;
  }
}

export type TickCount = Contract.TickCount;
export const TickCount: Contract.TickCountFactory = TickCountImpl;
`;
function referenceProject(): string {
  const dir = temp();
  const domain = join(dir, "contexts/clock/src/domain");
  mkdirSync(join(domain, "ticks"), { recursive: true });
  mkdirSync(join(domain, "shared"), { recursive: true });
  writeFileSync(join(dir, "spec.md"), "# Clock\n\nA tick count is a whole number, zero or more.\n");
  writeFileSync(join(domain, "shared/result.ts"), RESULT);
  writeFileSync(join(domain, "ticks/tick-count.contract.ts"), TICKS_CONTRACT);
  writeFileSync(join(domain, "ticks/tick-count.ts"), TICKS_IMPL);
  writeFileSync(join(dir, "package.json"), '{ "name": "adopt-fixture", "private": true, "type": "module", "workspaces": ["contexts/*"] }\n');
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext", module: "Preserve", moduleResolution: "bundler", allowImportingTsExtensions: true,
        verbatimModuleSyntax: true, strict: true, noEmit: true, skipLibCheck: true, types: [],
      },
      include: ["contexts/*/src"],
    }),
  );
  const modules = join(import.meta.dirname, "..", "..", "..", "node_modules");
  // Git canonicalizes macOS temporary paths (/var -> /private/var).
  symlinkSync(modules, join(dir, "node_modules"), "dir");
  writeProjectPacks(dir, ["ts", "ts-hexagonal"]);
  writeFileSync(join(dir, ".gitignore"), ".bounded/\nnode_modules/\n");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "baseline"]);
  return dir;
}

describe("change baseline and reviewer diff", () => {
  test("captures spec, contracts, glossary and decisions, then shows a unified change", () => {
    const dir = trackedProject();
    const baseline = captureChangeBaseline(dir);
    expect(Object.keys(baseline.files).sort()).toEqual([
      "ADRs/LEG-2026-001-loans.md", "CONTEXT.md", "contexts/lending/src/domain/items/item.contract.ts", "spec.md",
    ]);
    writeFileSync(join(dir, "spec.md"), "# Design\n\nA loan has a named borrower and due date.\n");
    writeFileSync(join(dir, "contexts/lending/src/domain/items/item.contract.ts"), "export declare function returnItem(id: string): void;\n");
    writeFileSync(join(dir, "contexts/lending/src/domain/items/receipt.contract.ts"), "export declare function receipt(): string;\n");
    writeFileSync(join(dir, "CONTEXT.md"), "# Terms\n\nBorrower means the person responsible for return.\n");
    writeFileSync(join(dir, "ADRs/LEG-2026-001-loans.md"), "# Loan decision\n\nReturns include a due date.\n");
    const diff = designDiff(dir);
    expect(diff.paths).toEqual(expect.arrayContaining([
      "ADRs/LEG-2026-001-loans.md", "CONTEXT.md", "spec.md", "contexts/lending/src/domain/items/item.contract.ts", "contexts/lending/src/domain/items/receipt.contract.ts",
    ]));
    expect(diff.lines.join("\n")).toContain("+A loan has a named borrower and due date.");
    expect(diff.lines.join("\n")).toContain("+export declare function receipt(): string;");
  });

  test("identical content moved to a new contract path is reported as a rename", () => {
    const dir = trackedProject();
    captureChangeBaseline(dir);
    const oldPath = join(dir, "contexts/lending/src/domain/items/item.contract.ts");
    const contents = readFileSync(oldPath, "utf8");
    rmSync(oldPath);
    writeFileSync(join(dir, "contexts/lending/src/domain/items/returned-item.contract.ts"), contents);
    const diff = designDiff(dir);
    expect(diff.lines).toContain("change-diff: renamed contexts/lending/src/domain/items/item.contract.ts → contexts/lending/src/domain/items/returned-item.contract.ts");
  });

  test("baseline corruption and composition changes are visible and refused", () => {
    const dir = trackedProject();
    captureChangeBaseline(dir);
    writeProjectPacks(dir, ["ts", "ts-hexagonal", "ts-trpc", "ts-web"]);
    expect(designDiff(dir).lines.some((line) => line.includes("packages ts, ts-hexagonal → ts, ts-hexagonal, ts-trpc, ts-web"))).toBe(true);
    const path = join(dir, BASELINE_PATH);
    const baseline = JSON.parse(readFileSync(path, "utf8"));
    baseline.files["spec.md"].content = "tampered";
    writeFileSync(path, JSON.stringify(baseline));
    expect(() => readChangeBaseline(dir)).toThrow(/invalid snapshot|fingerprint/);
  });
});

describe("change-diff without a baseline (issue #37)", () => {
  const projects: TempProject[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    while (projects.length) projects.pop()?.cleanup();
  });
  function ticketProject(boundary: "first" | "change" | undefined, extra: readonly Readonly<Record<string, unknown>>[] = []): string {
    vi.stubEnv("BOUNDED_TICKET", "");
    const events = boundary === undefined ? extra : [
      { ...prepared("4"), detail: { kind: "run-prepared", ticket: "4", boundary } }, ...extra,
    ];
    const p = makeLeadProject({
      ".bounded/active-ticket": "4\n",
      "docs/tn/TN-4.md": "---\nissue: 4\nstatus: active\ncontracts:\n  - contexts/notes/src/t4.contract.ts\n---\n\n# Ticket 4\n",
      "contexts/notes/src/t4.contract.ts": "export interface T4 {}\n",
      ...(events.length > 0 ? { [LOG]: logLines(...events) } : {}),
    });
    projects.push(p);
    writeProjectPacks(p.dir, ["ts", "ts-hexagonal"]);
    return p.dir;
  }

  test("a first run reports that there is nothing to diff", () => {
    const diff = designDiff(ticketProject("first"));
    expect(diff.lines).toEqual([FIRST_RUN_LINE]);
    expect(diff.paths).toEqual([]);
  });

  test("a resumed first run is still a first run", () => {
    const resumed = { ...prepared("4"), detail: { kind: "run-prepared", ticket: "4", boundary: "resume" } };
    expect(designDiff(ticketProject("first", [runStart, resumed])).lines).toEqual([FIRST_RUN_LINE]);
  });

  test("a change run whose baseline is missing still fails", () => {
    expect(() => designDiff(ticketProject("change"))).toThrow(/cannot read \.bounded\/tickets\/4\/change-baseline\.json/);
  });

  test("no prepared run, or a delivered one, is not a first run", () => {
    expect(() => designDiff(ticketProject(undefined))).toThrow(/change-baseline\.json/);
    expect(() => designDiff(ticketProject("first", [runStart, delivered]))).toThrow(/change-baseline\.json/);
  });
});

describe("adopt", () => {
  test("adopts a clean, implemented reference without manufacturing run verdicts", async () => {
    const dir = referenceProject();
    const baseline = await adoptProject(dir);
    expect(baseline.files["spec.md"]).toBeDefined();
    expect(existsSync(join(dir, ".bounded/contract-checksums.json"))).toBe(true);
    expect(existsSync(join(dir, BASELINE_PATH))).toBe(true);
    const events = readFileSync(join(dir, ".bounded/guard-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((event) => event.guard === "deliver" || event.guard === "change-run")).toBe(false);
  });

  test("refuses a dirty checkout without recording a manifest or baseline", async () => {
    const dir = trackedProject();
    writeFileSync(join(dir, "spec.md"), "# Changed without commit\n");
    await expect(adoptProject(dir)).rejects.toThrow(/clean checkout/);
    expect(existsSync(join(dir, ".bounded/contract-checksums.json"))).toBe(false);
    expect(existsSync(join(dir, BASELINE_PATH))).toBe(false);
  });
});
