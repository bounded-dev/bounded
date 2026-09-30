import { writeProjectPacks } from "../../../src/project-composition.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  CONTRACT_RULE_IDS,
  contributedPurityOverrides,
  createContractLinter,
  formatProblems,
  lintContractSource,
} from "./contract-purity.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import { EXAMPLE_CONCEPTS } from "./testdata/example-domain.ts";

// --- programmatic core --------------------------------------------------------

describe("lintContractSource", () => {
  test("a clean contract produces no problems", async () => {
    // Its value object lives in its own contract, imported from there.
    const problems = await lintContractSource(
      'import type { OrderId } from "./order-id.contract.ts";\n' +
        "export interface Order { readonly id: OrderId }\n" +
        "export declare function create(o: Order): void;",
      "orders.contract.ts",
    );
    expect(problems).toEqual([]);
  });

  test("a function body is reported with the plugin rule id and position", async () => {
    const problems = await lintContractSource(
      "export function f() { return 1; }",
      "x.contract.ts",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].ruleId).toBe("bounded-ts/declaration-only");
    expect(problems[0].line).toBe(1);
  });

  test("non-contract files are out of scope (the gate only lints *.contract.ts)", async () => {
    const problems = await lintContractSource("export const x: number = 1;", "x.ts");
    expect(problems).toEqual([]);
  });

  // The gate enforces design quality, not just well-formedness (issue #3).
  // Fixtures are the real dogfood contracts: docs/dogfooding.md runs 1-3.
  test("naked primitives on the public surface are reported by the gate", async () => {
    const problems = await lintContractSource(
      "export interface Book { isbn: string; authors: string[] }\n" +
        "export interface ProgressEvent { pagesRead: number }",
      "book.contract.ts",
    );
    expect(problems.map((p) => p.ruleId)).toEqual([
      "bounded-ts/no-naked-primitives",
      "bounded-ts/no-naked-primitives",
      "bounded-ts/no-naked-primitives",
    ]);
    expect(problems[0].message).toMatch(/'isbn' is declared as 'string'/);
    expect(problems[1].message).toMatch(/'authors' is a collection of naked 'string'/);
    expect(problems[2].message).toMatch(/'pagesRead' is declared as 'number'/);
  });

  // Issue #10's real miss: the alias is not a primitive, so it slid past both
  // value-object rules — no class, so nothing downstream fired either.
  test("a bare alias to a built-in object type is reported by the gate", async () => {
    const problems = await lintContractSource(
      "export type CalendarDate = Date;\n",
      "billing.contract.ts",
    );
    expect(problems.map((p) => p.ruleId)).toEqual(["bounded-ts/no-naked-primitives"]);
    expect(problems[0].message).toMatch(/aliases a built-in object type/);
    expect(problems[0].message).toMatch(/mutable/);
  });

  test("the value-object version of the same contract is clean", async () => {
    // The naked primitives are replaced by value objects declared elsewhere.
    const problems = await lintContractSource(
      'import type { Isbn, AuthorName, PagesRead } from "./values.contract.ts";\n' +
        "export interface Book { readonly isbn: Isbn; readonly authors: readonly [AuthorName, ...AuthorName[]] }\n" +
        "export interface ProgressEvent { readonly pagesRead: PagesRead }\n" +
        "export interface ReadingListStore { save(book: Book): Promise<void>; load(): Promise<readonly Book[]> }",
      "book.contract.ts",
    );
    expect(problems).toEqual([]);
  });
});

// --- the contract-owns-the-name model (ADR 2026-059) -------------------------

describe("the ADR 2026-059 contract model", () => {
  test.each(EXAMPLE_CONCEPTS.map((c) => [c.contractPath, c.contract] as const))(
    "the worked example's %s is clean",
    async (path, source) => {
      expect(await lintContractSource(source, path)).toEqual([]);
    },
  );

  test("the worked example's create-note feature contract is clean", async () => {
    const source = `import type { Note, NoteText, ProjectId, Result } from "@example/project-management/domain";

// Wire input: what callers send.
export interface CreateNoteInput {
  readonly projectId: string;
  readonly text: string;
}

// Command: the input once validated into value objects.
export interface CreateNoteCommand {
  readonly __brand: "CreateNoteCommand";
  readonly projectId: ProjectId;
  readonly text: NoteText;
}

export interface CreateNoteCommandFactory {
  parse(raw: unknown): Result<CreateNoteCommand>;
}

// In port: what this feature offers.
export interface CreateNote {
  execute(command: CreateNoteCommand): Promise<Result<Note>>;
}

// Out port: exactly what this feature needs.
export interface CreateNoteStore {
  projectExists(id: ProjectId): Promise<boolean>;
  save(note: Note): Promise<void>;
}
`;
    expect(await lintContractSource(source, "contexts/project-management/src/application/notes/create-note/create-note.contract.ts")).toEqual([]);
  });

  test("the retired declare-class form is refused with the interface + factory remedy", async () => {
    const problems = await lintContractSource(
      'export declare class Currency {\n  private readonly __brand: "Currency";\n  private constructor();\n  readonly value: string;\n  static parse(raw: unknown): Currency | undefined;\n}\n',
      "contexts/shop/src/domain/money/currency.contract.ts",
    );
    expect(problems.map((p) => p.ruleId)).toEqual(["bounded-ts/declaration-only"]);
    expect(problems[0]!.message).toMatch(/retired contract form \(ADR 2026-059/);
    expect(problems[0]!.message).toContain("export interface Currency {");
    expect(problems[0]!.message).toContain("export interface CurrencyFactory {");
    expect(problems[0]!.message).toContain("parse(raw: unknown): Result<Currency>;");
  });

  test("a domain contract reaching into an implementation is refused", async () => {
    const note = EXAMPLE_CONCEPTS.find((c) => c.contractPath.endsWith("/note.contract.ts"))!;
    const problems = await lintContractSource(
      note.contract.replace("../projects/project-id.contract.ts", "../projects/project-id.ts"),
      note.contractPath,
    );
    expect(problems.map((p) => p.ruleId)).toEqual(["bounded-ts/contract-imports-contracts-only"]);
  });

  test("the retired rules are gone and the new ones are enforced", () => {
    expect(CONTRACT_RULE_IDS).not.toContain("bounded-ts/value-objects-own-contract");
    expect(CONTRACT_RULE_IDS).not.toContain("bounded-ts/no-cross-contract-type-import");
    expect(CONTRACT_RULE_IDS).toContain("bounded-ts/entity-shape");
    expect(CONTRACT_RULE_IDS).toContain("bounded-ts/contract-imports-contracts-only");
  });
});

// --- the contributed-overrides socket (TN-26-005) ----------------------------
//
// This is the one socket whose contributions can make a gate WEAKER, so the
// tests are about what composition may NOT do: it may narrow or extend the base
// config for a named file set, and it may not touch anything else.

describe("contributed purity overrides", () => {
  const overrides = contributedPurityOverrides();

  test("every override names a narrower file set, or only adds its own pack's rules", () => {
    for (const override of overrides) {
      expect(override.files.length, JSON.stringify(override)).toBeGreaterThan(0);
      if (!override.files.includes("**/*.contract.ts")) continue;
      // A block over every contract may not touch the gate's own rules: it can
      // only switch ON rules from the contributing pack's own plugin.
      const namespace = override.plugin?.namespace;
      expect(namespace, "an override matching every contract is a rewrite of the gate").toBeDefined();
      for (const [rule, severity] of Object.entries(override.rules)) {
        expect(rule.startsWith(`${namespace}/`), rule).toBe(true);
        expect(severity, rule).toBe("error");
      }
    }
  });

  test("every override records why it exists", () => {
    for (const override of overrides) {
      expect(override.why.trim().length, override.files.join(", ")).toBeGreaterThan(20);
    }
  });

  test("an override may only set severities the gate understands", () => {
    for (const override of overrides) {
      for (const [rule, severity] of Object.entries(override.rules)) {
        expect(["error", "off"], `${rule}`).toContain(severity);
      }
    }
  });

  // The ratified exemption, behaviourally (TN-26-006): a Button's
  // `label: string` IS a string, and the generic UI layer holds no domain.
  const BUTTON_CONTRACT =
    "export interface ButtonProps {\n" +
    "  readonly label: string;\n" +
    "  readonly tone: \"primary\" | \"destructive\";\n" +
    "  readonly disabled: boolean;\n" +
    "}\n";

  test("a generic UI contract may take primitives", async () => {
    expect(await lintContractSource(BUTTON_CONTRACT, "src/ui/shared/ui/button.contract.ts")).toEqual([]);
  });

  // The scope is one directory, and the whole design depends on it being one
  // directory: everywhere else, domain data crosses as a value object.
  test("the same contract one layer up is still refused", async () => {
    const problems = await lintContractSource(
      BUTTON_CONTRACT,
      "src/ui/entities/building/status.contract.ts",
    );
    expect(problems.map((p) => p.ruleId)).toContain("bounded-ts/no-naked-primitives");
  });

  test("and outside src/ui entirely", async () => {
    const problems = await lintContractSource(BUTTON_CONTRACT, "src/orders/orders.contract.ts");
    expect(problems.map((p) => p.ruleId)).toContain("bounded-ts/no-naked-primitives");
  });

  // Relaxing no-naked-primitives alone would have relaxed nothing: a contract
  // that survives it meets value-object-shape one message later.
  test("the exemption covers every rule that would refuse the same contract", async () => {
    const problems = await lintContractSource(
      'export interface Label {\n  readonly __brand: "Label";\n  readonly text: string;\n}\n',
      "src/ui/shared/ui/label.contract.ts",
    );
    expect(problems.map((p) => p.ruleId)).not.toContain("bounded-ts/value-object-shape");
    expect(problems.map((p) => p.ruleId)).not.toContain("bounded-ts/value-object-documented");
  });

  // What is NOT relaxed: a contract under shared/ui is still a contract.
  test("declaration-only still holds in the relaxed layer", async () => {
    const problems = await lintContractSource(
      "export const tone = \"primary\";\n",
      "src/ui/shared/ui/tokens.contract.ts",
    );
    expect(problems.map((p) => p.ruleId)).toContain("bounded-ts/declaration-only");
  });

  // The base config survives composition: an ordinary contract, matched by no
  // override, still meets every rule the ts pack enforces.
  test("a layered contract outside every override keeps the full rule set", async () => {
    for (const path of [
      "contexts/shop/src/domain/orders/order.contract.ts",
      "contexts/shop/src/application/orders/place-order/place-order.contract.ts",
    ]) {
      const config = await createContractLinter().calculateConfigForFile(path);
      const resolved = config.rules ?? {};
      expect(CONTRACT_RULE_IDS.filter((id) => resolved[id] === undefined)).toEqual([]);
      expect(CONTRACT_RULE_IDS.filter((id) => resolved[id] === 0 || resolved[id] === "off")).toEqual([]);
    }
  });

  // The import rule is scoped to the hexagonal layers (LAYERED_CONTRACT_GLOBS);
  // everything else still applies to a contract outside them.
  // contract-first freezing holds everywhere: the import rule binds a
  // flat-layout contract exactly as it binds a layered one.
  test("a contract outside the layers keeps the full rule set, the import rule included", async () => {
    const config = await createContractLinter().calculateConfigForFile("src/orders/orders.contract.ts");
    const resolved = config.rules ?? {};
    expect(CONTRACT_RULE_IDS.filter((id) => resolved[id] === undefined || resolved[id] === 0 || resolved[id] === "off")).toEqual([]);
  });

  test("an implementation import is refused outside the layers too", async () => {
    const problems = await lintContractSource(
      'import type { OrderId } from "./order-id.ts";\nexport interface Order { readonly id: OrderId }\n',
      "src/orders/orders.contract.ts",
    );
    expect(problems.map((p) => p.ruleId)).toEqual(["bounded-ts/contract-imports-contracts-only"]);
  });

  test("the gate passes the composed packs' support modules to the import rule", async () => {
    const source = 'import type { Ack } from "./service-runtime.js";\nexport declare function submit(): Ack;\n';
    // the installed set includes ts-service's shipped runtime (whose own
    // router rule may still object; only the import rule is asked here)
    const problems = await lintContractSource(source, "src/api/api.contract.ts");
    expect(problems.filter((p) => p.ruleId === "bounded-ts/contract-imports-contracts-only")).toEqual([]);
    const elsewhere = await lintContractSource(source.replace("service-runtime", "other-runtime"), "src/api/api.contract.ts");
    expect(elsewhere.map((p) => p.ruleId)).toContain("bounded-ts/contract-imports-contracts-only");
  });
});

describe("formatProblems (one greppable line per problem)", () => {
  test("path:line:col, rule, message", async () => {
    const results = await createContractLinter().lintText("export const x = 1;", {
      filePath: "src/orders/orders.contract.ts",
    });
    // lintText resolves the virtual path against the process cwd
    const lines = formatProblems(results, process.cwd());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^src\/orders\/orders\.contract\.ts:1:14\s+bounded-ts\/declaration-only\s+Contract files are declaration-only/,
    );
  });
});

// --- CLI (the gate as a command) ------------------------------------------------

const SCRIPT = join(import.meta.dirname, "contract-purity.ts");
// A value object in the ADR 2026-059 form, in a file named after it.
const GOOD_CONTRACT =
  'import type { Result } from "./shared/result.ts";\n\n/** Px: a valid value. */\nexport interface Px {\n  readonly __brand: "Px";\n  readonly value: number;\n  equals(other: Px): boolean;\n  toJSON(): number;\n}\n\nexport interface PxFactory {\n  parse(raw: unknown): Result<Px>;\n}\n';
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

describe("contract-purity CLI", () => {
  test("exit 0 with an OK summary for clean contracts", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-ok-"));
  writeProjectPacks(dir, ["ts"]);
    tmpDirs.push(dir);
      writeFileSync(join(dir, "px.contract.ts"), GOOD_CONTRACT);
    const r = runCli(dir, ["**/*.contract.ts"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/contract-purity: OK \(1 file\)/);
    // …and the pass is logged (a silent log must never masquerade as a clean run)
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guard: "contract-purity", verdict: "pass", summary: "OK (1 file)" });
  });

  test("exit 1 with greppable problem lines for impure contracts", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-bad-"));
  writeProjectPacks(dir, ["ts"]);
    tmpDirs.push(dir);
      writeFileSync(join(dir, "bad.contract.ts"), "import { Pool } from 'pg';\n");
    const r = runCli(dir, ["**/*.contract.ts"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /bad\.contract\.ts:1:1\s+bounded-ts\/declaration-only\s+.*'pg' is imported as a value/,
    );
    // …and the same value import of a package is refused by the import rule
    expect(r.stdout).toMatch(/bounded-ts\/contract-imports-contracts-only/);
    expect(r.stdout).toMatch(/contract-purity: 2 problems/);
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guard: "contract-purity", verdict: "block" });
    const problems = events[0].detail?.["problems"] as { ruleId: string; message: string }[];
    expect(problems[0].ruleId).toBe("bounded-ts/declaration-only");
    expect(problems[0].message).toMatch(/'pg' is imported as a value/);
  });

  test("runs when invoked through a symlink (the ~/.pi/agent case)", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-symlink-"));
  writeProjectPacks(dir, ["ts"]);
    tmpDirs.push(dir);
      writeFileSync(join(dir, "px.contract.ts"), GOOD_CONTRACT);
    const link = join(dir, "contract-purity.link.ts");
    symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, [link, "**/*.contract.ts"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/contract-purity: OK/);
  });

  test("exit 2 when no contract files match (silence is not success)", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-none-"));
  writeProjectPacks(dir, ["ts"]);
    tmpDirs.push(dir);
      const r = runCli(dir, ["src/**/*.contract.ts"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/contract-purity: no files matched/);
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "contract-purity", verdict: "error" });
  });

  // The architect's scratch zone (Fix 4): the default gate scope is
  // src/**/*.contract.ts, so a probe in the top-level scratch/ is never linted —
  // even an impure one. The zone overlaps no gate that globs the project.
  test("the default src scope never scans the scratch zone, impure or not", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-scratch-"));
  writeProjectPacks(dir, ["ts"]);
    tmpDirs.push(dir);
      mkdirSync(join(dir, "scratch"), { recursive: true });
    writeFileSync(join(dir, "scratch", "probe.contract.ts"), "import { Pool } from 'pg';\n");
    const r = runCli(dir, ["src/**/*.contract.ts"]);
    expect(r.status).toBe(2); // no files matched — scratch is outside src/**
    expect(r.stderr).toMatch(/contract-purity: no files matched/);
  });
});
