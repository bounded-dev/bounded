// Portable, stack-neutral evidence for a design handed from one ticket to another.
// A pack decides what a reviewed freeze means and supplies the artifact selectors;
// this module only compares committed bytes across Git revisions.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import picomatch from "picomatch";

export interface HandoffReceipt {
  readonly version: 1;
  readonly producer: string;
  readonly revision: string;
  readonly gate: string;
  readonly selectors: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}

export interface HandoffCheck {
  readonly ok: boolean;
  readonly reason: string;
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function gitBlob(cwd: string, revision: string, path: string): Buffer {
  return execFileSync("git", ["show", `${revision}:${path}`], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

export function revisionOf(cwd: string, ref: string): string {
  if (ref.startsWith("-")) throw new Error("ref must not start with '-'");
  return git(cwd, "rev-parse", "--verify", `${ref}^{commit}`);
}

export function repoPrefix(cwd: string): string {
  return git(cwd, "rev-parse", "--show-prefix");
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A pack passes selectors that include its gate root; no technology is named here. */
export function filesAt(cwd: string, revision: string, selectors: readonly string[]): Record<string, string> {
  if (selectors.length === 0 || selectors.some((s) => !s || s.startsWith("/") || s.includes(".."))) {
    throw new Error("artifact selectors must be nonempty repository-relative paths or globs");
  }
  const matches = picomatch([...selectors], { dot: true });
  const root = git(cwd, "rev-parse", "--show-toplevel");
  const names = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", revision], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).split("\0").filter(Boolean);
  const files: Record<string, string> = {};
  for (const name of names.filter((n) => matches(n)).sort()) {
    files[name] = hash(gitBlob(root, revision, name));
  }
  if (Object.keys(files).length === 0) throw new Error("artifact selectors matched no committed files");
  return files;
}

export function makeReceipt(
  cwd: string,
  producer: string,
  gate: string,
  selectors: readonly string[],
  ref = "HEAD",
): HandoffReceipt {
  if (!producer.trim() || !gate.trim()) throw new Error("producer and gate are required");
  const revision = revisionOf(cwd, ref);
  return { version: 1, producer, revision, gate, selectors: [...selectors], files: filesAt(cwd, revision, selectors) };
}

export function parseReceipt(raw: unknown): HandoffReceipt {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("receipt must be an object");
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.producer !== "string" || !r.producer ||
      typeof r.gate !== "string" || !r.gate || typeof r.revision !== "string" ||
      !/^[0-9a-f]{40,64}$/.test(r.revision) || !Array.isArray(r.selectors) ||
      r.selectors.length === 0 || r.selectors.some((s) => typeof s !== "string") ||
      typeof r.files !== "object" || r.files === null || Array.isArray(r.files)) {
    throw new Error("malformed handoff receipt");
  }
  const files = r.files as Record<string, unknown>;
  if (Object.keys(files).length === 0 || Object.entries(files).some(([path, digest]) =>
    !path || path.startsWith("/") || path.includes("..") || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))) {
    throw new Error("malformed handoff file hashes");
  }
  return r as unknown as HandoffReceipt;
}

export function readReceipt(path: string): HandoffReceipt {
  const raw = JSON.parse(readFileSync(path, "utf8") as string) as unknown;
  const receipt = typeof raw === "object" && raw !== null && "detail" in raw
    ? (raw as { detail?: { receipt?: unknown } }).detail?.receipt
    : raw;
  return parseReceipt(receipt);
}

function diff(expected: Readonly<Record<string, string>>, actual: Readonly<Record<string, string>>): HandoffCheck {
  const changed = Object.keys(expected).filter((p) => p in actual && expected[p] !== actual[p]).sort();
  const added = Object.keys(actual).filter((p) => !(p in expected)).sort();
  const removed = Object.keys(expected).filter((p) => !(p in actual)).sort();
  return {
    ok: changed.length + added.length + removed.length === 0,
    reason: changed.length + added.length + removed.length === 0 ? "handoff unchanged" : "handed-off design changed",
    changed, added, removed,
  };
}

/** Check receipt bytes against its pinned revision and freshness against the producer's live ref. */
export function checkReceipt(cwd: string, receipt: HandoffReceipt, producerRef: string): HandoffCheck {
  const pinned = filesAt(cwd, receipt.revision, receipt.selectors);
  const original = diff(receipt.files, pinned);
  if (!original.ok) return { ...original, reason: "receipt does not match its pinned revision" };
  const current = filesAt(cwd, revisionOf(cwd, producerRef), receipt.selectors);
  return diff(receipt.files, current);
}
