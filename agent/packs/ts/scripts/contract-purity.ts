// contract-purity gate (TN-26-001, DESIGN stage): *.contract.ts files must be
// declaration-only, express the domain in value objects, and use the
// contract-owns-the-name form of ADR 2026-059. Thin CLI over ESLint + the
// bounded-ts plugin.
// The orchestrator runs this; the architect never lints its own work.
//
// The two rules answer different questions: declaration-only asks "is this a
// well-formed contract?", no-naked-primitives asks "does it say anything?"
// (issue #3 — dogfood runs where a weaker model shipped `isbn: string` past a
// gate that only checked well-formedness).
//
//   node contract-purity.ts ["src/**/*.contract.ts" ...]
//
// Exit 0 clean · 1 problems (one greppable line each) · 2 no files matched
// (silence is not success — a gate that matches nothing is a broken gate).

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { ESLint } from "eslint";
import parser from "@typescript-eslint/parser";
import plugin from "../eslint/index.ts";
import { composedPacks, installedPacks } from "../../installed.ts";
import { contractPurityOverrides, contractSupportFiles, type ContractPurityOverride } from "../pack.ts";
import { supportModuleNames } from "./scaffold-contract.ts";
import { formatProblems, toProblems, type Problem } from "./lint-report.ts";
export { formatProblems, type Problem };
// Harness-core guard log (NOTE: this relative import only resolves when the
// pack runs inside the harness checkout; pack distribution is issue #4).
import { logGuardEvent } from "../../../src/guard-log.ts";

/** Every rule id the contract gate enforces — exported for guard-doc-drift. */
export const CONTRACT_RULE_IDS: readonly string[] = [
  "bounded-ts/declaration-only",
  "bounded-ts/no-naked-primitives",
  "bounded-ts/no-branded-aliases",
  "bounded-ts/value-object-shape",
  "bounded-ts/entity-shape",
  "bounded-ts/value-object-documented",
  "bounded-ts/contract-imports-contracts-only",
  "bounded-ts/no-schema-on-surface",
];

// --- Contributed overrides (TN-26-005, the ts pack's socket) -----------------
//
// The ts pack DEFINES `contractPurityOverrides` (packs/ts/pack.ts); this gate
// READS it. `CONTRACT_RULE_IDS` above stays the ts pack's own base config —
// composition may narrow or extend it for a pack's own corner of the tree, and
// may not replace it.
//
// ORDER IS THE MECHANISM. ESLint flat config applies matching blocks in array
// order, last one winning, so contributed blocks go AFTER the base block and a
// `"off"` in one of them is a real relaxation for the files it names. That is
// deliberate and it is the only way a ratified exemption can exist at all
// (TN-26-006: a Button's `label: string` is legitimate). Every block names its
// own files glob and carries a recorded reason — the socket's validation hook
// refuses one that does not.

/** Every purity override a composed pack contributes, in pack order. */
export function contributedPurityOverrides(cwd?: string): readonly ContractPurityOverride[] {
  return (cwd === undefined ? installedPacks() : composedPacks(cwd)).read(contractPurityOverrides);
}

/** Rule ids a composed pack adds to this gate from its own plugin, for
 *  reporting and brief-drift checks alongside `CONTRACT_RULE_IDS`. */
export function contributedContractRuleIds(cwd?: string): readonly string[] {
  return contributedPurityOverrides(cwd).flatMap((override) =>
    override.plugin === undefined
      ? []
      : Object.keys(override.rules).filter((id) => id.startsWith(`${override.plugin!.namespace}/`)),
  );
}

/** One flat-config plugin object per contributed namespace. ESLint refuses two
 *  different objects under one namespace, so every block shares these. */
function contributedPurityPlugins(overrides: readonly ContractPurityOverride[]): Map<string, ESLint.Plugin> {
  const out = new Map<string, ESLint.Plugin>();
  for (const { plugin: contributed } of overrides) {
    if (contributed === undefined) continue;
    const existing = (out.get(contributed.namespace) as { rules?: Record<string, unknown> } | undefined)?.rules ?? {};
    // Same upstream RuleModule/Plugin type friction as the base plugin below.
    out.set(contributed.namespace, { rules: { ...existing, ...contributed.rules } } as unknown as ESLint.Plugin);
  }
  return out;
}

export function createContractLinter(cwd?: string): ESLint {
  const registry = cwd === undefined ? installedPacks() : composedPacks(cwd);
  const overrides = contributedPurityOverrides(cwd);
  const packPlugins = contributedPurityPlugins(overrides);
  return new ESLint({
    ...(cwd === undefined ? {} : { cwd }),
    // The gate owns the whole config: no project eslint config is consulted,
    // so results are identical in every repo.
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.contract.ts"],
        languageOptions: { parser },
        // @typescript-eslint RuleModule and eslint's flat-config Plugin type
        // are structurally incompatible (known upstream friction); runtime fine.
        plugins: { "bounded-ts": plugin as unknown as ESLint.Plugin },
        rules: {
          "bounded-ts/declaration-only": "error",
          "bounded-ts/no-naked-primitives": "error",
          // Run 9: a branded ALIAS with an optional brand passed every gate
          // and enforced nothing; the required form cannot be built without a
          // cast the src lint bans. Concepts are interface pairs instead.
          "bounded-ts/no-branded-aliases": "error",
          // The contract-owns-the-name model (ADR 2026-059): a concept is
          // 'interface <Name>' + 'interface <Name>Factory'. no-naked-primitives
          // says a primitive may not cross the boundary; these say what must
          // be there instead — a value object's brand, single 'value', parse
          // returning Result; an entity's fields, construct signature and
          // identity — one concept per file named after it.
          "bounded-ts/value-object-shape": "error",
          "bounded-ts/entity-shape": "error",
          // An optional doc comment, but when present its '@accepts'
          // examples feed the generated laws, so they must be literals of the
          // value's own type.
          "bounded-ts/value-object-documented": "error",
          // A contract imports only other contracts and the shared Result, as
          // types — every contract, so the frozen design never depends on a
          // builder-written file (contract-first freezing). An application
          // contract may also import its context's generated domain barrel
          // (ADR 2026-059, lead decision Q3). It replaces the retired
          // no-cross-contract-type-import, whose rule was the opposite under
          // the declare-class model.
          "bounded-ts/contract-imports-contracts-only": [
            "error",
            { supportModules: supportModuleNames(registry.read(contractSupportFiles)) },
          ],
          // zod is the engine inside a value object, never a public identity:
          // nothing from zod may appear in a contract (ADR 2026-031).
          "bounded-ts/no-schema-on-surface": "error",
        },
      },
      // Contributed blocks last — see the note above. Each re-registers the
      // plugin object (the same object, which flat config permits) so a block
      // naming a `bounded-ts/…` rule resolves it without depending on how
      // ESLint happens to merge plugins across matching blocks.
      ...overrides.map((override) => ({
        files: [...override.files],
        languageOptions: { parser },
        plugins: {
          "bounded-ts": plugin as unknown as ESLint.Plugin,
          ...(override.plugin === undefined
            ? {}
            : { [override.plugin.namespace]: packPlugins.get(override.plugin.namespace)! }),
        },
        rules: { ...override.rules },
      })),
    ],
  });
}

export async function lintContractSource(source: string, fileName: string): Promise<Problem[]> {
  const results = await createContractLinter().lintText(source, { filePath: fileName });
  return toProblems(results);
}

/** One greppable line per problem: path:line:col  rule  message */

/** Verdict of one contract-purity run: exit code plus the lines the CLI prints. */
export interface PurityRun {
  readonly code: number;
  readonly lines: readonly string[];
}

/**
 * Run the contract-purity gate and return its verdict without printing.
 *
 * The architect reaches this through the `contract_purity` tool rather than a
 * shell, and the CLI reaches it through `main`. One implementation, two
 * callers — a gate that differs by how it was invoked is not a gate.
 */
export async function runContractPurity(
  cwd: string,
  patterns: readonly string[] = ["src/**/*.contract.ts"],
): Promise<PurityRun> {
  return await gate(cwd, [...patterns]);
}

async function main(argv: string[]): Promise<number> {
  const result = await gate(process.cwd(), argv.length > 0 ? argv : ["src/**/*.contract.ts"]);
  for (const line of result.lines) {
    if (result.code === 2) console.error(line);
    else console.log(line);
  }
  return result.code;
}

async function gate(cwd: string, patterns: string[]): Promise<PurityRun> {
  const linter = createContractLinter(cwd);
  // ESLint throws its own wording when a pattern matches nothing; normalize
  // to the gate's stable message.
  const noMatch = (): PurityRun => {
    const summary = `no files matched [${patterns.join(", ")}]`;
    logGuardEvent(cwd, { guard: "contract-purity", verdict: "error", summary });
    return {
      code: 2,
      lines: [`contract-purity: ${summary} — a gate that matches nothing is a broken gate`],
    };
  };

  let results: ESLint.LintResult[];
  try {
    results = await linter.lintFiles(patterns);
  } catch (e) {
    if (e instanceof Error && /No files matching/.test(e.message)) return noMatch();
    throw e;
  }
  const fileCount = results.length;
  if (fileCount === 0) return noMatch();

  const problems = formatProblems(results, cwd);
  const files = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  if (problems.length > 0) {
    const summary = `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${files}`;
    logGuardEvent(cwd, {
      guard: "contract-purity",
      verdict: "block",
      summary,
      detail: { problems: toProblems(results) },
    });
    return { code: 1, lines: [...problems, `contract-purity: ${summary}`] };
  }
  const summary = `OK (${files})`;
  logGuardEvent(cwd, { guard: "contract-purity", verdict: "pass", summary });
  return { code: 0, lines: [`contract-purity: ${summary}`] };
}

// Symlink-safe main check: the harness is reached via the ~/.pi/agent symlink,
// so argv[1] (symlink path) and import.meta.url (realpath) differ — compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`contract-purity: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
