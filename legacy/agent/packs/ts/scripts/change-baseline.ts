// Driver-owned change baseline. This records a design snapshot; it never adds
// gate verdicts or edits a project's contracts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { computeManifest, findContractFiles, hashContract, manifestRelative, serializeManifest } from "./checksum-gate.ts";
import { readProjectPacks } from "../../../src/project-composition.ts";
import { activeTicketDesign, designNotePath } from "../../../src/ticket-design.ts";

export interface ChangeBaseline {
  readonly version: 1;
  readonly packs: readonly string[];
  readonly fingerprint: string;
  readonly files: Readonly<Record<string, { readonly hash: string; readonly content: string }>>;
}

export const BASELINE_PATH = ".bounded/change-baseline.json";
export function baselineRelative(root: string): string {
  const ticket = activeTicketDesign(root)?.ticket;
  return ticket ? `.bounded/tickets/${ticket}/change-baseline.json` : BASELINE_PATH;
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function knowledgeFiles(root: string): string[] {
  const out: string[] = [];
  const context = join(root, "CONTEXT.md");
  if (existsSync(context)) out.push(context);
  const adrs = join(root, "ADRs");
  if (existsSync(adrs)) {
    for (const entry of readdirSync(adrs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) out.push(join(adrs, entry.name));
    }
  }
  return out.sort();
}

export function snapshotDesign(root: string): ChangeBaseline {
  const note = designNotePath(root);
  const spec = join(root, note);
  if (!existsSync(spec)) throw new Error(`${note} is required to establish a change baseline`);
  const ticket = activeTicketDesign(root);
  const contracts = ticket ? ticket.contracts.map((path) => join(root, path)) : findContractFiles(root);
  if (contracts.length === 0) throw new Error("at least one *.contract.ts file is required to establish a change baseline");
  const files: Record<string, { hash: string; content: string }> = {};
  for (const path of [spec, ...contracts, ...knowledgeFiles(root)]) {
    const content = readFileSync(path, "utf8");
    files[relativePath(root, path)] = { hash: hashContract(content), content };
  }
  const packs = readProjectPacks(root);
  const fingerprintInput = JSON.stringify({ packs: [...packs].sort(), files: Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => [path, value.hash]),
  ) });
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");
  return { version: 1, packs: [...packs].sort(), fingerprint, files };
}

export function readChangeBaseline(root: string): ChangeBaseline {
  let raw: unknown;
  const baselinePath = baselineRelative(root);
  try { raw = JSON.parse(readFileSync(join(root, baselinePath), "utf8")); }
  catch (error) { throw new Error(`cannot read ${baselinePath}: ${error instanceof Error ? error.message : String(error)}`); }
  if (raw === null || typeof raw !== "object") throw new Error(`${BASELINE_PATH} is malformed`);
  const value = raw as Partial<ChangeBaseline>;
  if (value.version !== 1 || typeof value.fingerprint !== "string" || !Array.isArray(value.packs) ||
      value.packs.some((pack) => typeof pack !== "string") || value.files === null || typeof value.files !== "object") {
    throw new Error(`${BASELINE_PATH} is malformed`);
  }
  for (const [path, file] of Object.entries(value.files)) {
    if (path.startsWith("/") || path.split("/").includes("..") || file === null || typeof file !== "object" ||
        typeof file.hash !== "string" || typeof file.content !== "string" || hashContract(file.content) !== file.hash) {
      throw new Error(`${BASELINE_PATH} has an invalid snapshot for '${path}'`);
    }
  }
  const fingerprintInput = JSON.stringify({ packs: [...value.packs].sort(), files: Object.fromEntries(
    Object.entries(value.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => [path, file.hash]),
  ) });
  const actual = createHash("sha256").update(fingerprintInput).digest("hex");
  if (actual !== value.fingerprint) throw new Error(`${BASELINE_PATH} fingerprint does not match its snapshot`);
  return value as ChangeBaseline;
}

function atomicWrite(path: string, contents: string): string {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, contents, { flag: "wx" });
  return temporary;
}

function writeSnapshot(root: string, snapshot: ChangeBaseline, includeContracts: boolean): void {
  const baseline = baselineRelative(root);
  const manifest = manifestRelative(root);
  const directory = join(root, baseline, "..");
  mkdirSync(directory, { recursive: true });
  const baselinePath = join(root, baseline);
  const baselineTemp = atomicWrite(baselinePath, JSON.stringify(snapshot, null, 2) + "\n");
  let manifestTemp: string | undefined;
  try {
    if (includeContracts) {
      manifestTemp = atomicWrite(join(root, manifest), serializeManifest(computeManifest(root)));
    }
    if (manifestTemp) renameSync(manifestTemp, join(root, manifest));
    renameSync(baselineTemp, baselinePath);
  } catch (error) {
    rmSync(baselineTemp, { force: true });
    if (manifestTemp) rmSync(manifestTemp, { force: true });
    if (includeContracts) rmSync(join(root, manifest), { force: true });
    throw error;
  }
}

/** Capture a successful prior delivery before a new change boundary opens. */
export function captureChangeBaseline(root: string): ChangeBaseline {
  const snapshot = snapshotDesign(root);
  writeSnapshot(root, snapshot, false);
  return snapshot;
}

function assertCleanTrackedCheckout(root: string): void {
  let top: string;
  try {
    top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("adoption requires a Git checkout at the project root");
  }
  if (realpathSync(top) !== realpathSync(root)) throw new Error("adoption must run at the Git checkout root");
  const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  if (status.trim() !== "") throw new Error("adoption requires a clean checkout; commit or remove tracked changes and untracked files first");
  const ticket = activeTicketDesign(root);
  for (const path of [designNotePath(root), ...(ticket?.contracts ?? findContractFiles(root).map((file) => relativePath(root, file)))]) {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", path], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
  }
}

/**
 * Adopt a clean existing project after validating it with the same deterministic
 * checks used by the design stage. Writes provenance only after every check
 * passes; no synthetic guard events are created.
 */
export async function adoptProject(root: string): Promise<ChangeBaseline> {
  if (existsSync(join(root, manifestRelative(root))) || existsSync(join(root, baselineRelative(root))) ||
      existsSync(join(root, ".bounded", "guard-log.jsonl"))) {
    throw new Error("this project already has developer-stage state; use bounded change-run instead of adoption");
  }
  assertCleanTrackedCheckout(root);
  const { composedPacks } = await import("../../installed.ts");
  composedPacks(root); // Validates installed names and dependency edges.
  const [{ runContractPurity }, { lintSrc }, { typecheck }, { checkProjectSurfaces }] = await Promise.all([
    import("./contract-purity.ts"), import("./lint-src.ts"), import("./typecheck.ts"), import("./surface-check.ts"),
  ]);
  const purity = await runContractPurity(root);
  if (purity.code !== 0) throw new Error(`contract-purity failed: ${purity.lines.join("; ")}`);
  const lint = await lintSrc(root);
  if (lint.code !== 0) throw new Error(`lint-src failed: ${lint.lines.join("; ")}`);
  const checked = await typecheck(root);
  if (!checked.ok) throw new Error(`typecheck failed: ${checked.diagnostics.join("; ")}`);
  const { sourceRoots } = await import("../../../src/pack-contrib.ts");
  const surface = checkProjectSurfaces(root, sourceRoots(root));
  if (surface.code !== 0) throw new Error(`surface-check failed: ${surface.lines.join("; ")}`);
  const snapshot = snapshotDesign(root);
  writeSnapshot(root, snapshot, true);
  return snapshot;
}
