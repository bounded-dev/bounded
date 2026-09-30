import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { writeProjectPacks } from "../../../src/project-composition.ts";
import { adoptProject, captureChangeBaseline, readChangeBaseline, BASELINE_PATH } from "./change-baseline.ts";
import { designDiff } from "./change-diff.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "change-cycle-"));
  dirs.push(dir);
  return dir;
}
function trackedProject(): string {
  const dir = temp();
  mkdirSync(join(dir, "src/domain"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".bounded/\nnode_modules/\n");
  writeFileSync(join(dir, "spec.md"), "# Design\n\nA loan has one borrower.\n");
  writeFileSync(join(dir, "src/domain/item.contract.ts"), "export declare function returnItem(): void;\n");
  writeFileSync(join(dir, "CONTEXT.md"), "# Terms\n\nBorrower means the person holding an item.\n");
  mkdirSync(join(dir, "ADRs"));
  writeFileSync(join(dir, "ADRs/2026-001-loans.md"), "# Loan decision\n\nReturns are explicit.\n");
  writeProjectPacks(dir, ["ts"]);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "baseline"]);
  return dir;
}
/** A clean, implemented project in the flat layout adoption checks today:
 *  one contract, its implementation, and the config the gates read. (It used
 *  to copy packs/ts/reference, which now holds the hexagonal worked example,
 *  ADR 2026-059.) */
function referenceProject(): string {
  const dir = temp();
  mkdirSync(join(dir, "src/clock"), { recursive: true });
  writeFileSync(join(dir, "spec.md"), "# Clock\n\nA tick advances nothing and returns nothing.\n");
  writeFileSync(join(dir, "src/clock/clock.contract.ts"), "export declare function tick(): void;\n");
  writeFileSync(join(dir, "src/clock/clock.ts"), "export function tick(): void {}\n");
  writeFileSync(join(dir, "package.json"), '{ "name": "adopt-fixture", "private": true, "type": "module" }\n');
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true },
      include: ["src/**/*.ts"],
    }),
  );
  const modules = join(import.meta.dirname, "..", "..", "..", "node_modules");
  // Git canonicalizes macOS temporary paths (/var -> /private/var).
  symlinkSync(modules, join(dir, "node_modules"), "dir");
  writeProjectPacks(dir, ["ts"]);
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
      "ADRs/2026-001-loans.md", "CONTEXT.md", "spec.md", "src/domain/item.contract.ts",
    ]);
    writeFileSync(join(dir, "spec.md"), "# Design\n\nA loan has a named borrower and due date.\n");
    writeFileSync(join(dir, "src/domain/item.contract.ts"), "export declare function returnItem(id: string): void;\n");
    writeFileSync(join(dir, "src/domain/receipt.contract.ts"), "export declare function receipt(): string;\n");
    writeFileSync(join(dir, "CONTEXT.md"), "# Terms\n\nBorrower means the person responsible for return.\n");
    writeFileSync(join(dir, "ADRs/2026-001-loans.md"), "# Loan decision\n\nReturns include a due date.\n");
    const diff = designDiff(dir);
    expect(diff.paths).toEqual(expect.arrayContaining([
      "ADRs/2026-001-loans.md", "CONTEXT.md", "spec.md", "src/domain/item.contract.ts", "src/domain/receipt.contract.ts",
    ]));
    expect(diff.lines.join("\n")).toContain("+A loan has a named borrower and due date.");
    expect(diff.lines.join("\n")).toContain("+export declare function receipt(): string;");
  });

  test("identical content moved to a new contract path is reported as a rename", () => {
    const dir = trackedProject();
    captureChangeBaseline(dir);
    const oldPath = join(dir, "src/domain/item.contract.ts");
    const contents = readFileSync(oldPath, "utf8");
    rmSync(oldPath);
    writeFileSync(join(dir, "src/domain/returned-item.contract.ts"), contents);
    const diff = designDiff(dir);
    expect(diff.lines).toContain("change-diff: renamed src/domain/item.contract.ts → src/domain/returned-item.contract.ts");
  });

  test("baseline corruption and composition changes are visible and refused", () => {
    const dir = trackedProject();
    captureChangeBaseline(dir);
    writeProjectPacks(dir, ["ts", "ts-hexagonal", "ts-trpc", "ts-web"]);
    expect(designDiff(dir).lines.some((line) => line.includes("packages ts → ts, ts-hexagonal, ts-trpc, ts-web"))).toBe(true);
    const path = join(dir, BASELINE_PATH);
    const baseline = JSON.parse(readFileSync(path, "utf8"));
    baseline.files["spec.md"].content = "tampered";
    writeFileSync(path, JSON.stringify(baseline));
    expect(() => readChangeBaseline(dir)).toThrow(/invalid snapshot|fingerprint/);
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
