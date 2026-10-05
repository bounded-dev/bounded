// Generic driver for pack-owned project lifecycle commands.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readProjectPacks } from "../src/project-composition.ts";
import { composedPacks } from "./installed.ts";

/**
 * The script of the one composed pack that provides `command`. By default the
 * packs are this harness's own, in composition order; with `packsDir` they
 * are read, as data, from that directory (a project's `.bounded/harness/packs`,
 * the source the lead's commands read every socket from).
 */
export function commandScript(cwd: string, command: string, packsDir?: string): string {
  const packs = packsDir === undefined ? composedPacks(cwd).packs : readProjectPacks(cwd);
  const root = packsDir ?? dirname(fileURLToPath(import.meta.url));
  const matches: string[] = [];
  for (const pack of packs) {
    const directory = join(root, pack);
    const manifestPath = join(directory, "contrib.json");
    let manifest: unknown;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
    catch { throw new Error(`selected pack '${pack}' has no readable contrib.json`); }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`selected pack '${pack}' contrib.json must be an object`);
    }
    const commands = (manifest as Record<string, unknown>)["projectCommands"];
    if (commands === undefined) continue;
    if (commands === null || typeof commands !== "object" || Array.isArray(commands)) {
      throw new Error(`selected pack '${pack}' projectCommands must be an object`);
    }
    const target = (commands as Record<string, unknown>)[command];
    if (target === undefined) continue;
    if (typeof target !== "string" || target.startsWith("/") || target.split("/").includes("..")) {
      throw new Error(`selected pack '${pack}' has an invalid '${command}' command path`);
    }
    const script = resolve(directory, target);
    const relativeScript = relative(directory, script);
    if (relativeScript.startsWith(`..${sep}`) || relativeScript === ".." || !existsSync(script)) {
      throw new Error(`selected pack '${pack}' command '${command}' points outside the pack or to a missing file`);
    }
    matches.push(script);
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `no selected pack provides '${command}'`
      : `more than one selected pack provides '${command}'; command ownership must be unique`);
  }
  return matches[0]!;
}

export function runProjectCommand(command: string, cwd: string, args: readonly string[] = []): number {
  const script = commandScript(cwd, command);
  const result = spawnSync(process.execPath, [script, cwd, ...args], { cwd, stdio: "inherit" });
  return result.status ?? 1;
}

/** Run a project command as `runProjectCommand` does, capturing its output
 *  instead of inheriting the terminal: for a caller that reports it. */
export function captureProjectCommand(
  command: string, cwd: string, args: readonly string[] = [], packsDir?: string,
): { readonly ok: boolean; readonly output: string } {
  const script = commandScript(cwd, command, packsDir);
  const result = spawnSync(process.execPath, [script, cwd, ...args], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error !== undefined ? result.error.message : ""}`.trim();
  return { ok: result.status === 0, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  let cwd = process.cwd();
  const flag = args.indexOf("--cwd");
  if (flag >= 0) {
    if (!args[flag + 1] || args[flag + 1]!.startsWith("--")) {
      console.error("usage: bounded <pack-command> [--cwd <project>]");
      process.exit(64);
    }
    cwd = resolve(args[flag + 1]!);
    args.splice(flag, 2);
  }
  if (!command) {
    console.error("usage: bounded <pack-command> [--cwd <project>]");
    process.exit(64);
  }
  try { process.exitCode = runProjectCommand(command, cwd, args); }
  catch (error) {
    console.error(`bounded: BLOCK — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
