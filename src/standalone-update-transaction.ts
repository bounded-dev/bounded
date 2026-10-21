import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { NpmClosureSnapshot } from "./standalone-npm-closure.ts";

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
type Bytes = { readonly content: string | null; readonly mode: number | null };
export interface StandaloneUpdateFile {
  readonly path: string;
  readonly before: Bytes;
  readonly after: Bytes;
}
interface JournalFile { readonly path: string; readonly before: Bytes; readonly after: Bytes }
export interface StandaloneUpdateJournal {
  readonly schema: "bounded-update-journal/1";
  readonly source: { readonly kind: "standalone" | "npm"; readonly version: string };
  readonly targetVersion: string;
  readonly targetKind?: "npm";
  readonly npmClosure?: NpmClosureSnapshot;
  readonly sourceFiles: Readonly<Record<string, string>>;
  readonly files: readonly JournalFile[];
  readonly managed?: { readonly oldOwnedDirectories: readonly string[]; readonly newOwnedDirectories: readonly string[] };
  readonly rollbackRecordBefore?: Bytes;
  readonly intent?: "rollback";
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const missing = (error: unknown): boolean => record(error) && error.code === "ENOENT";
const allowed = new Set([".claude/settings.json", ".pi/extensions/bounded/index.ts", ".bounded/version.json"]);
const managedMetadata = new Set([".bounded/packs.lock.json", ".bounded/types-receipt.json"]);
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const updateJournalFileCountBound = 20_010;
const updateJournalByteBound = 768 * 1024 * 1024;
function validBytes(side: Record<string, unknown>): side is Record<string, unknown> & Bytes {
  return (side.content === null || typeof side.content === "string")
    && (side.mode === null || (Number.isInteger(side.mode) && Number(side.mode) >= 0 && Number(side.mode) <= 0o777))
    && (side.content === null) === (side.mode === null)
    && (typeof side.content !== "string" || Buffer.from(side.content, "base64").toString("base64") === side.content);
}
function managedProjectionPath(path: string): boolean {
  return path.startsWith("node_modules/") && path.split("/").length >= 3
    && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\"));
}
function managedFilePath(path: string): boolean { return managedMetadata.has(path) || managedProjectionPath(path); }
function managedDirectoryPath(path: string): boolean {
  return path.startsWith("node_modules/") && path.split("/").length >= 2
    && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\"));
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function syncDirectory(path: string): void {
  try { syncFile(path); }
  catch (error) {
    // Windows does not permit opening a directory for fsync.
    if (process.platform !== "win32") throw error;
  }
}

function safeComponents(projectRoot: string, ownedPath: string, allowMissingAncestors = false): string {
  let current = projectRoot;
  const rootInfo = lstatSync(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`${current} is linked or not a project directory`);
  const parts = ownedPath.split(/[\\/]/);
  for (const [index, part] of parts.entries()) {
    if (part === "" || part === "." || part === "..") throw new Error(`${ownedPath} is not a safe project path`);
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error(`${current} is linked; preserve the update journal`);
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`${current} is not a directory`);
    } catch (error) {
      if (!missing(error)) throw error;
      if (index < parts.length - 1 && !allowMissingAncestors) throw new Error(`${current} is missing; preserve the update journal`);
    }
  }
  return current;
}

function inspect(projectRoot: string, ownedPath: string): Bytes {
  const path = safeComponents(projectRoot, ownedPath, true);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} is linked or not a regular file`);
    return { content: readFileSync(path).toString("base64"), mode: info.mode & 0o777 };
  } catch (error) {
    if (missing(error)) return { content: null, mode: null };
    throw error;
  }
}

function same(left: Bytes, right: Bytes): boolean {
  return left.content === right.content && left.mode === right.mode;
}

function verifyCurrentFiles(projectRoot: string, files: readonly JournalFile[], side: "before" | "after"): void {
  for (const file of files) {
    if (!same(inspect(projectRoot, file.path), file[side]))
      throw new Error(`${file.path} changed during ${side === "before" ? "restored-source" : "committed-target"} verification; preserve the update journal`);
  }
}

function directoryPaths(journal: StandaloneUpdateJournal, side: "before" | "after"): readonly string[] {
  if (journal.managed === undefined) return [];
  return side === "before" ? journal.managed.oldOwnedDirectories : journal.managed.newOwnedDirectories;
}

function ensureDirectories(projectRoot: string, directories: readonly string[]): void {
  for (const path of [...directories].sort((a, b) => a.split("/").length - b.split("/").length)) {
    const absolute = safeComponents(projectRoot, path, true);
    if (existsSync(absolute)) {
      const info = lstatSync(absolute);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${absolute} is linked or not an owned directory`);
      continue;
    }
    mkdirSync(absolute, { recursive: false, mode: 0o755 });
    syncDirectory(dirname(absolute));
  }
}

function removeObsoleteDirectories(projectRoot: string, from: readonly string[], to: readonly string[]): void {
  const retained = new Set(to);
  for (const path of [...from].filter((item) => !retained.has(item)).sort((a, b) => b.split("/").length - a.split("/").length)) {
    const absolute = safeComponents(projectRoot, path, true);
    if (!existsSync(absolute)) continue;
    const info = lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${absolute} is linked or not an owned directory`);
    rmdirSync(absolute);
    syncDirectory(dirname(absolute));
  }
}

function verifyCurrentDirectories(projectRoot: string, journal: StandaloneUpdateJournal, side: "before" | "after"): void {
  const directories = directoryPaths(journal, side);
  const paths = journal.files.filter((file) => file[side].content !== null).map((file) => file.path);
  for (const path of directories) {
    const absolute = safeComponents(projectRoot, path);
    const info = lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${absolute} changed during managed update verification`);
    const expected = [...new Set([...paths, ...directories]
      .filter((owned) => owned.startsWith(`${path}/`))
      .map((owned) => owned.slice(path.length + 1).split("/")[0]))].sort();
    if (JSON.stringify(readdirSync(absolute).sort()) !== JSON.stringify(expected))
      throw new Error(`${absolute} gained or lost an owned projection entry; preserve the update journal`);
  }
}

function writeExact(projectRoot: string, ownedPath: string, expected: Bytes, desired: Bytes): void {
  const path = safeComponents(projectRoot, ownedPath);
  if (!same(inspect(projectRoot, ownedPath), expected)) throw new Error(`${path} changed during the project update; leave the update journal for recovery`);
  if (same(expected, desired)) return;
  if (desired.content === null) {
    rmSync(path);
    syncDirectory(dirname(path));
    return;
  }
  const parent = dirname(path);
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`${parent} is linked or not a directory`);
  const staged = join(parent, `.bounded-update-${randomUUID()}.tmp`);
  try {
    writeFileSync(staged, Buffer.from(desired.content, "base64"), { flag: "wx", mode: desired.mode ?? 0o644 });
    chmodSync(staged, desired.mode ?? 0o644);
    syncFile(staged);
    if (!same(inspect(projectRoot, ownedPath), expected)) throw new Error(`${path} changed while staging the project update`);
    renameSync(staged, path);
    syncDirectory(parent);
  } finally { rmSync(staged, { force: true }); }
}

function verifySourceFiles(projectRoot: string, sourceFiles: Readonly<Record<string, string>>): void {
  for (const [path, expected] of Object.entries(sourceFiles)) {
    safeComponents(projectRoot, relative(projectRoot, path));
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || digest(readFileSync(path)) !== expected)
      throw new Error(`Project source ${path} changed after semantic preflight; retry the update`);
  }
}

function journalPath(projectRoot: string): string { return join(projectRoot, ".bounded", "update-journal.json"); }

function validateJournal(value: unknown, projectRoot: string): StandaloneUpdateJournal {
  if (!record(value) || value.schema !== "bounded-update-journal/1" || !record(value.source)
    || (value.source.kind !== "standalone" && value.source.kind !== "npm") || typeof value.source.version !== "string"
    || !versionPattern.test(value.source.version) || typeof value.targetVersion !== "string"
    || !versionPattern.test(value.targetVersion) || !record(value.sourceFiles) || !Array.isArray(value.files))
    throw new Error("project update journal is malformed; preserve it for manual recovery");
  if (value.files.length > updateJournalFileCountBound) throw new Error("update journal exceeds file-count bound");
  if (Object.keys(value.sourceFiles).length > updateJournalFileCountBound) throw new Error("update journal exceeds source-file-count bound");
  if (value.intent !== undefined && value.intent !== "rollback") throw new Error("project update journal has an unknown intent");
  if (value.targetKind !== undefined && value.targetKind !== "npm") throw new Error("project update journal has an unknown target kind");
  const npmSide = value.source.kind === "npm" || value.targetKind === "npm";
  if (value.source.kind === "npm" && value.targetKind === "npm") throw new Error("project update journal has no standalone release side");
  if (npmSide) {
    if (!record(value.npmClosure) || value.npmClosure.schema !== "bounded-npm-closure/1"
      || value.npmClosure.version !== "3.3.0" || !record(value.npmClosure.files)
      || !record(value.npmClosure.directories) || !record(value.npmClosure.packages)
      || (value.source.kind === "npm" ? value.source.version : value.targetVersion) !== value.npmClosure.version)
      throw new Error("project update journal has no verified npm closure snapshot");
  } else if (value.npmClosure !== undefined) throw new Error("project update journal has an unbound npm closure snapshot");
  let rollbackRecordBefore: Bytes | undefined;
  if (value.rollbackRecordBefore !== undefined) {
    if (!record(value.rollbackRecordBefore) || !validBytes(value.rollbackRecordBefore))
      throw new Error("project update journal has malformed previous rollback-record bytes");
    rollbackRecordBefore = value.rollbackRecordBefore;
  }
  let managed: StandaloneUpdateJournal["managed"];
  if (value.managed !== undefined) {
    if (npmSide) throw new Error("project update journal cannot bind a managed projection to an npm generation");
    if (!record(value.managed) || !Array.isArray(value.managed.oldOwnedDirectories)
      || !Array.isArray(value.managed.newOwnedDirectories)) throw new Error("project update journal has malformed managed directory inventories");
    for (const directories of [value.managed.oldOwnedDirectories, value.managed.newOwnedDirectories]) {
      if (directories.some((path: unknown) => typeof path !== "string" || !managedDirectoryPath(path))
        || new Set(directories).size !== directories.length)
        throw new Error("project update journal has an unsafe managed directory path");
    }
    managed = { oldOwnedDirectories: value.managed.oldOwnedDirectories as string[],
      newOwnedDirectories: value.managed.newOwnedDirectories as string[] };
  }
  const files: JournalFile[] = [];
  const seen = new Set<string>();
  for (const item of value.files) {
    if (!record(item) || typeof item.path !== "string" || !(allowed.has(item.path) || (managed !== undefined && managedFilePath(item.path))) || seen.has(item.path)
      || !record(item.before) || !record(item.after)) throw new Error("project update journal has an unknown or duplicate owned path");
    for (const side of [item.before, item.after]) {
      if (!validBytes(side))
        throw new Error("project update journal has invalid file bytes or mode");
    }
    seen.add(item.path);
    files.push({ path: item.path, before: item.before as Bytes, after: item.after as Bytes });
  }
  if (files.at(-1)?.path !== ".bounded/version.json") throw new Error("project update journal does not publish the pin last");
  if (managed !== undefined && (!seen.has(".bounded/packs.lock.json") || !seen.has(".bounded/types-receipt.json")))
    throw new Error("project update journal lacks its managed lock or receipt");
  for (const [path, hash] of Object.entries(value.sourceFiles)) {
    const withinProject = relative(projectRoot, path);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || withinProject === ""
      || withinProject === ".." || withinProject.startsWith(`..${sep}`) || isAbsolute(withinProject))
      throw new Error("project update journal has invalid source inventory");
  }
  return { schema: "bounded-update-journal/1", source: value.source as StandaloneUpdateJournal["source"],
    targetVersion: value.targetVersion, sourceFiles: value.sourceFiles as Record<string, string>, files,
    ...(value.targetKind === "npm" ? { targetKind: "npm" as const } : {}),
    ...(npmSide ? { npmClosure: value.npmClosure as unknown as NpmClosureSnapshot } : {}),
    ...(managed === undefined ? {} : { managed }),
    ...(rollbackRecordBefore === undefined ? {} : { rollbackRecordBefore }),
    ...(value.intent === "rollback" ? { intent: "rollback" as const } : {}) };
}

function writeJournal(projectRoot: string, journal: StandaloneUpdateJournal): void {
  const path = safeComponents(projectRoot, ".bounded/update-journal.json");
  if (existsSync(path)) throw new Error(`${path} already exists; run bounded update to recover it`);
  const bytes = `${JSON.stringify(journal)}\n`;
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  syncFile(path);
  syncDirectory(dirname(path));
}

export interface StandaloneUpdateVerifiers {
  /** Verify the recorded rollback bytes and source release before changing any project file. */
  readonly beforeRestore: (journal: StandaloneUpdateJournal) => Promise<Result<void>>;
  /** Verify the complete restored source after every project file matches the old snapshot. */
  readonly restoredSource: (journal: StandaloneUpdateJournal) => Promise<Result<void>>;
  /** Verify the complete committed target before the marker is removed. */
  readonly committedTarget: (journal: StandaloneUpdateJournal) => Promise<Result<void>>;
}

function saveRollbackRecord(projectRoot: string, journal: StandaloneUpdateJournal): void {
  const path = safeComponents(projectRoot, ".bounded/update-rollback.json");
  const prior = journal.rollbackRecordBefore ?? { content: null, mode: null };
  const next: Bytes = journal.intent === "rollback" ? { content: null, mode: null }
    : { content: Buffer.from(`${JSON.stringify(journal)}\n`).toString("base64"), mode: 0o600 };
  writeExact(projectRoot, ".bounded/update-rollback.json", prior, next);
  if (next.content !== null) syncFile(path);
}

/** Read the one retained generation; callers must still authenticate both recorded states before publication. */
export function readStandaloneRollbackRecord(projectRoot: string): Result<StandaloneUpdateJournal | null> {
  try {
    const path = safeComponents(projectRoot, ".bounded/update-rollback.json");
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(path); }
    catch (error) { if (missing(error)) return { ok: true, value: null }; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} is linked or not a regular rollback record`);
    if (info.size > updateJournalByteBound) throw new Error("rollback record exceeds byte bound");
    const record = validateJournal(JSON.parse(readFileSync(path, "utf8")) as unknown, projectRoot);
    if (record.intent === "rollback") throw new Error("rollback record is already consumed");
    return { ok: true, value: record };
  } catch (error) { return { ok: false, error: `Cannot read rollback record: ${errorText(error)}` }; }
}

/** Invert a verified update generation without changing project files. */
export function createStandaloneRollbackJournal(projectRoot: string, recorded: StandaloneUpdateJournal): StandaloneUpdateJournal {
  const inverse: StandaloneUpdateJournal = {
    schema: "bounded-update-journal/1", source: { kind: "standalone", version: recorded.targetVersion },
    targetVersion: recorded.source.version, sourceFiles: recorded.sourceFiles,
    ...(recorded.source.kind === "npm" ? { targetKind: "npm" as const, npmClosure: recorded.npmClosure } : {}),
    files: recorded.files.map((file) => ({ path: file.path, before: file.after, after: file.before })),
    ...(recorded.managed === undefined ? {} : { managed: {
      oldOwnedDirectories: recorded.managed.newOwnedDirectories, newOwnedDirectories: recorded.managed.oldOwnedDirectories } }),
    rollbackRecordBefore: inspect(projectRoot, ".bounded/update-rollback.json"), intent: "rollback",
  };
  return validateJournal(inverse, projectRoot);
}

/** Finish a committed journal or restore every old byte. The caller holds the update writer. */
export async function recoverStandaloneUpdate(projectRoot: string, verifiers: StandaloneUpdateVerifiers,
  limits: { readonly maxJournalBytes?: number } = {}): Promise<Result<"source" | "target">> {
  const path = journalPath(projectRoot);
  try {
    safeComponents(projectRoot, ".bounded/update-journal.json");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} is linked or not a regular journal`);
    const maxJournalBytes = Math.min(limits.maxJournalBytes ?? updateJournalByteBound, updateJournalByteBound);
    if (!Number.isSafeInteger(maxJournalBytes) || maxJournalBytes < 1 || info.size > maxJournalBytes)
      throw new Error("update journal exceeds byte bound");
    const journal = validateJournal(JSON.parse(readFileSync(path, "utf8")) as unknown, projectRoot);
    verifySourceFiles(projectRoot, journal.sourceFiles);
    const rollbackPrerequisites = await verifiers.beforeRestore(journal);
    if (!rollbackPrerequisites.ok) return rollbackPrerequisites;
    const states = journal.files.map((file) => {
      const current = inspect(projectRoot, file.path);
      if (same(current, file.before) || same(current, file.after)) return current;
      throw new Error(`${file.path} differs from both recorded project update states; preserve ${path}`);
    });
    if (states.every((state, index) => {
      const file = journal.files[index];
      return file !== undefined && same(state, file.after);
    })) {
      const verified = await verifiers.committedTarget(journal);
      verifyCurrentFiles(projectRoot, journal.files, "after");
      verifyCurrentDirectories(projectRoot, journal, "after");
      if (verified.ok) {
        saveRollbackRecord(projectRoot, journal);
        verifyCurrentFiles(projectRoot, journal.files, "after");
        verifyCurrentDirectories(projectRoot, journal, "after");
        rmSync(path);
        syncDirectory(dirname(path));
        return { ok: true, value: "target" };
      }
    }
    ensureDirectories(projectRoot, directoryPaths(journal, "before"));
    for (const file of [...journal.files].reverse()) {
      const current = inspect(projectRoot, file.path);
      if (same(current, file.before)) continue;
      writeExact(projectRoot, file.path, file.after, file.before);
    }
    removeObsoleteDirectories(projectRoot, directoryPaths(journal, "after"), directoryPaths(journal, "before"));
    const verified = await verifiers.restoredSource(journal);
    if (!verified.ok) return verified;
    verifyCurrentFiles(projectRoot, journal.files, "before");
    verifyCurrentDirectories(projectRoot, journal, "before");
    rmSync(path);
    syncDirectory(dirname(path));
    return { ok: true, value: "source" };
  } catch (error) { return { ok: false, error: `Cannot recover ${path}: ${errorText(error)}` }; }
}

/** Publish host files first and the pin last, with an update marker before the first replacement. */
export async function publishStandaloneUpdate(projectRoot: string, journal: StandaloneUpdateJournal,
  verifiers: StandaloneUpdateVerifiers): Promise<Result<void>> {
  try {
    const checked = validateJournal(journal, projectRoot);
    verifySourceFiles(projectRoot, checked.sourceFiles);
    if (!same(inspect(projectRoot, ".bounded/update-rollback.json"), checked.rollbackRecordBefore ?? { content: null, mode: null }))
      throw new Error("Previous rollback record changed during update preparation; retry the update");
    const trustedSnapshots = await verifiers.beforeRestore(checked);
    if (!trustedSnapshots.ok) return trustedSnapshots;
    for (const file of checked.files) {
      const current = inspect(projectRoot, file.path);
      if (!same(current, file.before)) throw new Error(`${file.path} changed after update preparation`);
    }
    verifyCurrentDirectories(projectRoot, checked, "before");
    writeJournal(projectRoot, checked);
    ensureDirectories(projectRoot, directoryPaths(checked, "after"));
    for (const file of checked.files.slice(0, -1)) writeExact(projectRoot, file.path, file.before, file.after);
    removeObsoleteDirectories(projectRoot, directoryPaths(checked, "before"), directoryPaths(checked, "after"));
    const pin = checked.files.at(-1);
    if (pin === undefined) throw new Error("update has no project version pin");
    writeExact(projectRoot, pin.path, pin.before, pin.after);
    const recovered = await recoverStandaloneUpdate(projectRoot, verifiers);
    if (!recovered.ok) return recovered;
    if (recovered.value !== "target") return { ok: false, error: "Project update rolled back after target verification failed" };
    return { ok: true, value: undefined };
  } catch (error) {
    if (existsSync(journalPath(projectRoot))) {
      const recovered = await recoverStandaloneUpdate(projectRoot, verifiers);
      return { ok: false, error: `${errorText(error)}; ${recovered.ok ? "the previous project state was restored" : recovered.error}` };
    }
    return { ok: false, error: errorText(error) };
  }
}

export function captureStandaloneUpdateFile(projectRoot: string, path: string, nextBytes: string | Uint8Array | null,
  mode: number | null, managed = false): StandaloneUpdateFile {
  if (!(allowed.has(path) || (managed && managedFilePath(path)))) throw new Error(`Update may not own ${path}`);
  return { path, before: inspect(projectRoot, path), after: { content: nextBytes === null ? null : Buffer.from(nextBytes).toString("base64"), mode } };
}

export function createStandaloneUpdateJournal(projectRoot: string, source: StandaloneUpdateJournal["source"], targetVersion: string,
  sourceFiles: Readonly<Record<string, Uint8Array>>, files: readonly StandaloneUpdateFile[],
  managed?: StandaloneUpdateJournal["managed"], npmClosure?: NpmClosureSnapshot): StandaloneUpdateJournal {
  return { schema: "bounded-update-journal/1", source, targetVersion,
    sourceFiles: Object.fromEntries(Object.entries(sourceFiles).map(([path, bytes]) => [path, digest(bytes)])),
    files: files.map(({ path, before, after }) => ({ path, before, after })),
    ...(managed === undefined ? {} : { managed }), ...(npmClosure === undefined ? {} : { npmClosure }),
    rollbackRecordBefore: inspect(projectRoot, ".bounded/update-rollback.json") };
}
