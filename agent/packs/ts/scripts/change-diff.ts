import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { isMainModule } from "../../../src/is-main-module.ts";
import { findContractFiles, hashContract } from "./checksum-gate.ts";
import { baselineRelative, readChangeBaseline } from "./change-baseline.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import { activeTicketDesign, designNotePath } from "../../../src/ticket-design.ts";

export interface DesignDiff {
  readonly fingerprint: string;
  readonly paths: readonly string[];
  readonly lines: readonly string[];
}

function currentFiles(root: string): Record<string, string> {
  const ticket = activeTicketDesign(root, { siblings: "ignore" });
  const paths = [join(root, designNotePath(root)), ...(ticket ? ticket.contracts.map((path) => join(root, path)) : findContractFiles(root))];
  const context = join(root, "CONTEXT.md");
  try { readFileSync(context); paths.push(context); } catch { /* optional */ }
  const adrs = join(root, "ADRs");
  try {
    for (const name of readdirSync(adrs)) if (name.endsWith(".md")) paths.push(join(adrs, name));
  } catch { /* optional */ }
  const files: Record<string, string> = {};
  for (const path of paths) {
    try { files[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf8"); }
    catch { /* deleted since the baseline */ }
  }
  return files;
}

function unifiedDiff(oldPath: string, oldText: string, newPath: string, newText: string, temp: string, index: number): string[] {
  const oldFile = join(temp, `old-${index}`);
  const newFile = join(temp, `new-${index}`);
  writeFileSync(oldFile, oldText);
  writeFileSync(newFile, newText);
  const result = spawnSync("diff", ["-u", "-L", `a/${oldPath}`, "-L", `b/${newPath}`, oldFile, newFile], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git diff failed: ${result.stderr.trim()}`);
  return result.stdout.trimEnd().split("\n");
}

export function designDiff(root: string): DesignDiff {
  const baseline = readChangeBaseline(root);
  const note = designNotePath(root);
  if (!Object.hasOwn(baseline.files, note)) throw new Error(`${baselineRelative(root)} has no ${note} snapshot`);
  const current = currentFiles(root);
  const oldPaths = Object.keys(baseline.files).sort();
  const newPaths = Object.keys(current).sort();
  const oldHashes = new Map(oldPaths.map((path) => [path, baseline.files[path]!.hash]));
  const newHashes = new Map(newPaths.map((path) => [path, hashContract(current[path]!)]));
  const removed = oldPaths.filter((path) => !(path in current));
  const added = newPaths.filter((path) => !(path in baseline.files));
  const renamed = new Map<string, string>();
  for (const from of removed) {
    const to = added.find((path) => newHashes.get(path) === oldHashes.get(from));
    if (to) { renamed.set(from, to); added.splice(added.indexOf(to), 1); }
  }
  const pairs: Array<[string, string, string, string]> = [];
  for (const path of oldPaths) {
    const newPath = renamed.get(path) ?? path;
    if (!(newPath in current)) pairs.push([path, path, baseline.files[path]!.content, ""]);
    else if (baseline.files[path]!.hash !== newHashes.get(newPath)) {
      pairs.push([path, newPath, baseline.files[path]!.content, current[newPath]!]);
    }
  }
  for (const path of added) pairs.push([path, path, "", current[path]!]);
  const temp = mkdtempSync(join(tmpdir(), "bounded-change-diff-"));
  try {
    const lines = [
      `change-diff: baseline ${baseline.fingerprint}`,
      `change-diff: packages ${baseline.packs.join(", ")} → ${readProjectPacks(root).join(", ")}`,
      ...[...renamed].map(([from, to]) => `change-diff: renamed ${from} → ${to}`),
      ...added.map((path) => `change-diff: added ${path}`),
      ...removed.filter((path) => !renamed.has(path)).map((path) => `change-diff: removed ${path}`),
    ];
    pairs.forEach(([from, to, before, after], index) => lines.push(...unifiedDiff(from, before, to, after, temp, index)));
    if (pairs.length === 0 && baseline.packs.join("\0") === readProjectPacks(root).join("\0")) {
      lines.push(`change-diff: no changes to ${note}, contracts, CONTEXT.md or ADRs`);
    }
    const fingerprint = createHash("sha256").update(newPaths.map((path) => `${path}\0${newHashes.get(path)}`).join("\n")).digest("hex");
    return { fingerprint, paths: pairs.map(([from, to]) => from === to ? from : `${from} → ${to}`), lines };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (isMainModule(import.meta.url)) {
  const cwd = process.argv[2] ?? process.cwd();
  try {
    const result = designDiff(cwd);
    for (const line of result.lines) console.log(line);
  } catch (error) {
    console.error(`change-diff: BLOCK — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
