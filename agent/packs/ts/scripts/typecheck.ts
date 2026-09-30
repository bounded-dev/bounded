// typecheck custom tool core (TN-26-001, §"Custom tools").
//
// Runs `bunx tsc -p tsconfig.json` in the target project (ADR 2026-062; the
// generated tsconfig sets noEmit) and returns pass/fail plus the diagnostics,
// with absolute machine paths redacted: paths under the project root are
// relativized, and any remaining absolute path is replaced with `[path]`.
// Relative source locations are kept (they aid debugging, and they are what
// typecheck-routing.ts and typecheck-scope.ts attribute to a role by the
// file's suffix); only machine layout is scrubbed.
//
// Pure core (redactAbsolutePaths / parseTscOutput) + injectable command runner,
// so the parsing and redaction are unit-testable without spawning tsc.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import type { CommandOutput, CommandRunner } from "./run-tests.ts";
import { configDriftReason } from "./project-config.ts";

export type { CommandOutput, CommandRunner };

export interface TypecheckOptions {
  readonly run?: CommandRunner;
  /** Override the tsc invocation. Default: {@link TYPECHECK_COMMAND}. */
  readonly command?: string;
  readonly args?: string[];
}

export interface TypecheckResult {
  /** True when tsc exited 0 (no type errors). */
  readonly ok: boolean;
  readonly errorCount: number;
  /** One diagnostic per line, absolute paths redacted, in tsc order. */
  readonly diagnostics: string[];
}

/** The type-check invocation: the project's own compiler through bunx, on the
 *  generated tsconfig.json, with one-line diagnostics the routing can parse. */
export const TYPECHECK_COMMAND: { readonly command: string; readonly args: readonly string[] } = {
  command: "bunx",
  args: ["tsc", "-p", "tsconfig.json", "--pretty", "false"],
};

// Any residual absolute path (POSIX, Windows drive, or file:// URI) with a
// filename — redacted after project-root relativization strips the paths the
// builder is allowed to see. The leading-slash lookbehind keeps in-project
// RELATIVE paths (`src/a.ts`, whose slash follows a word char) untouched.
const ABS_PATH_TOKEN =
  /(?<![\w./])(?:file:\/\/)?(?:[A-Za-z]:)?(?:\/[\w.\-]+)+\.[A-Za-z][\w.]*(?:\(\d+,\d+\))?/g;

const spawnRunner: CommandRunner = (command, args, cwd, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });

/**
 * Redact absolute machine paths from tsc output:
 *   1. strip the project-root prefix so in-project paths become relative
 *      (the builder is allowed to see `src/foo.ts(1,2)`);
 *   2. replace any remaining absolute path (node_modules elsewhere, temp dirs)
 *      with `[path]`.
 */
export function redactAbsolutePaths(text: string, cwd: string): string {
  const root = cwd.replace(/[/\\]+$/, "");
  // Relativize both `/root/...` and `file:///root/...` forms.
  const relativized = text
    .split(`${root}/`)
    .join("")
    .split(`${root}\\`)
    .join("");
  return relativized.replace(ABS_PATH_TOKEN, "[path]");
}

/** Parse captured tsc output into a redacted diagnostics view. */
export function parseTscOutput(
  stdout: string,
  stderr: string,
  code: number | null,
  cwd: string,
): TypecheckResult {
  const combined = [stdout, stderr].filter((s) => s.trim() !== "").join("\n");
  const redacted = redactAbsolutePaths(combined, cwd);
  const diagnostics = redacted
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .filter((l) => l.trim() !== "");
  const errorCount = (redacted.match(/error TS\d+/g) ?? []).length;
  return { ok: code === 0, errorCount, diagnostics };
}

/** Type-check `cwd` and return the redacted diagnostics view. */
export async function typecheck(cwd: string, options: TypecheckOptions = {}): Promise<TypecheckResult> {
  // The type-checker reads the project's config: refuse to spawn it over
  // config the composed packs did not generate (ADR 2026-054).
  const drift = configDriftReason(cwd);
  if (drift !== undefined) return { ok: false, errorCount: 0, diagnostics: [drift] };
  const run = options.run ?? spawnRunner;
  const command = options.command ?? TYPECHECK_COMMAND.command;
  const args = options.args ?? [...TYPECHECK_COMMAND.args];
  const { stdout, stderr, code } = await run(command, args, cwd);
  return parseTscOutput(stdout, stderr, code, cwd);
}

/** Human-readable rendering for the tool's text output. */
export function formatTypecheck(result: TypecheckResult): string {
  if (result.ok) return "typecheck: OK — no type errors";
  const head = `typecheck: ${result.errorCount} error${result.errorCount === 1 ? "" : "s"}`;
  return result.diagnostics.length > 0 ? `${head}\n\n${result.diagnostics.join("\n")}` : head;
}

// --- CLI ------------------------------------------------------------------------

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
  typecheck(process.argv[2] ?? process.cwd()).then(
    (result) => {
      console.log(formatTypecheck(result));
      process.exit(result.ok ? 0 : 1);
    },
    (e: unknown) => {
      console.error(`typecheck: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
