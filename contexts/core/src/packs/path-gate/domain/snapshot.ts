import type { snapshotBrand } from "./snapshot.contract.ts";
import { type Result, readSafely, sameWire, wireFormOf } from "bounded/domain";
import type * as Contract from "./snapshot.contract.ts";

const SHA256 = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** A text as it can be shown on one line: control characters (a newline in a file's name) escaped, as in JSON. */
const shown = (text: string): string => [...text].map((char) => (char === "\u007f" ? "\\u007f" : char < " " ? JSON.stringify(char).slice(1, -1) : char)).join("");

/** How a file was kept, checked for form; its content is checked against its hash where it is restored. */
function keptOf(kept: Record<string, unknown>, path: string): Result<Contract.Kept> {
  if (kept.from === "commit") return { ok: true, value: { from: "commit" } };
  if (kept.from === "nowhere") return { ok: true, value: { from: "nowhere" } };
  if (kept.from !== "copy") return { ok: false, error: `${shown(path)} is not a snapshot's file` };
  const { content, executable } = kept;
  if (typeof content !== "string" || typeof executable !== "boolean") return { ok: false, error: `the copy of ${shown(path)} does not match its hash` };
  return { ok: true, value: { from: "copy", content, executable } };
}

/** One file of a snapshot, checked for form against the number of rules. */
function fileOf(file: unknown, path: string, ruleCount: number): Result<Contract.SnapshotFile> {
  if (!isRecord(file) || typeof file.hash !== "string" || !SHA256.test(file.hash)) return { ok: false, error: `${shown(path)} has a hash that is not a SHA-256` };
  const { hash, size, rule, kept, link, rules } = file;
  const watchedBy = rules === undefined ? undefined : Array.isArray(rules) && rules.every((index) => isCount(index) && index < ruleCount) ? Object.freeze(rules.filter(isCount)) : null;
  if (!isCount(size) || !isCount(rule) || rule >= ruleCount || !isRecord(kept) || !(link === undefined || link === true) || watchedBy === null) return { ok: false, error: `${shown(path)} is not a snapshot's file` };
  const keptAs = keptOf(kept, path);
  if (!keptAs.ok) return keptAs;
  return { ok: true, value: Object.freeze({ hash, size, rule, kept: Object.freeze(keptAs.value), ...(link === true ? { link } : {}), ...(watchedBy === undefined ? {} : { rules: watchedBy }) }) };
}

class SnapshotImpl implements Contract.Snapshot {
  declare readonly __brand: "Snapshot";
  declare readonly [snapshotBrand]: true;
  readonly #made = true;

  private constructor(
    readonly commit: string | null,
    readonly files: Readonly<Record<string, Contract.SnapshotFile>>,
  ) {
    Object.freeze(this);
  }

  /** Whether `raw` was made by this class (not merely an object that inherits from one): parse checks its wire form again, since a constructor can be called at run time. */
  static made(raw: unknown): raw is SnapshotImpl {
    return typeof raw === "object" && raw !== null && #made in raw;
  }

  static parse(raw: unknown, ruleCount: number): Result<Contract.Snapshot> {
    return readSafely<Contract.Snapshot>("A snapshot", () => {
      const given = SnapshotImpl.made(raw) ? wireFormOf(raw) : raw;
      if (!isRecord(given) || !isRecord(given.files) || !(given.commit === null || typeof given.commit === "string")) return { ok: false, error: "it is not a snapshot" };
      const files: Record<string, Contract.SnapshotFile> = {};
      for (const [path, file] of Object.entries(given.files)) {
        const parsed = fileOf(file, path, ruleCount);
        if (!parsed.ok) return parsed;
        files[path] = parsed.value;
      }
      return { ok: true, value: new SnapshotImpl(given.commit, Object.freeze(files)) };
    });
  }

  equals(other: Contract.Snapshot): boolean {
    return sameWire(this, other);
  }

  toJSON(): Contract.SnapshotJSON {
    return { commit: this.commit, files: this.files };
  }
}

export type Snapshot = Contract.Snapshot;
export const Snapshot: Contract.SnapshotFactory = SnapshotImpl;
