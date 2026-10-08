import type { Composition, ExecuteEffect, ExtensionPoint, Result, ToolResult, ToolUse } from "bounded/domain";
import { Verdict } from "bounded/domain";
import type { PathGateId } from "../../domain/path-gate-id.contract.ts";
import type { ProtectedPath } from "../../domain/protected-path.contract.ts";
import { Snapshot } from "../../domain/snapshot.ts";
import type { WatchedChange } from "../../domain/watched-path.contract.ts";
import type { Watched } from "../../domain/watched-rules.contract.ts";
import { watchedRulesOf } from "../../domain/watched-rules.ts";
import type { DriftReport, FileChange, RestoreFrom, ShellSnapshots, SnapshotFile, WatchedFiles, WatchedHashes, WatchShell, WatchShellOptions } from "./watch-shell.contract.ts";

const NOTHING: DriftReport = Object.freeze({ changed: Object.freeze([]), restored: true, message: null, record: null });
const UNREADABLE_REDIRECT = "Fix what stops protected files from being read; until then shell commands are refused";
const CHECK_REDIRECT = "Check the protected files by hand against version control";

/** How much a snapshot copies of the watched files that version control does not hold: 1 MB a file, 10 MB in all. */
export const COPY_LIMITS = Object.freeze({ perFile: 1_000_000, total: 10_000_000 });

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

/** A watched rule and the pack it is watched for. */
type Rule = Watched;

const runsShell = (call: ToolUse | ToolResult): boolean => call.effects.some((effect) => effect.kind === "execute");
/** A text as it can be shown on one line: control characters (a newline in a file's name) escaped, as in JSON. */
const shown = (text: string): string => [...text].map((char) => (char === "\u007f" ? "\\u007f" : char < " " ? JSON.stringify(char).slice(1, -1) : char)).join("");
/** A text as one sentence: without trailing full stops or spaces, then one full stop. */
const sentence = (words: string): string => `${words.replace(/[.\s]+$/, "")}.`;

/** The SHA-256 of base64 `content`, hex, with its size; undefined when it is not base64. */
async function digest(content: string): Promise<{ hash: string; size: number } | undefined> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { hash, size: bytes.length };
}

/**
 * Watches the files a shell command must not change. Before an allowed
 * command it snapshots them: each file's hash, and how to put it back (from
 * the commit when it matches it, else from a copy of its bytes, within
 * limits). After the command it puts back what changed, records it and says
 * so. A snapshot is stored outside the process, so it is checked before it
 * is trusted: one that is missing, unreadable or altered is reported against
 * the commit and recorded, and nothing is restored, since earlier work could
 * not be told apart from the command's.
 */
export class WatchShellHandler implements WatchShell {
  private readonly limits: { readonly perFile: number; readonly total: number };

  constructor(
    private readonly composition: Composition,
    private readonly protectedPaths: ExtensionPoint<ProtectedPath, PathGateId>,
    private readonly files: WatchedFiles,
    private readonly snapshots: ShellSnapshots,
    options: WatchShellOptions = {},
  ) {
    this.limits = options.limits ?? COPY_LIMITS;
  }

  async snapshot(call: ToolUse): Promise<Verdict> {
    try {
      if (!runsShell(call)) return Verdict.allow;
      const rules = this.rules();
      if (rules.length === 0) return Verdict.allow;
      if (call.callId === undefined) {
        return Verdict.refuse(
          "A shell command must carry its tool call id, so the protected files it may change can be checked afterwards",
          "Report this to the maintainers of the host adapter; the command is refused meanwhile",
        );
      }
      const captured = await this.capture(rules);
      if (!captured.ok) return Verdict.refuse(`Protected files could not be checked before this command: ${captured.error}`, UNREADABLE_REDIRECT);
      await this.snapshots.save(call.callId.value, captured.value);
      return Verdict.allow;
    } catch (thrown) {
      return Verdict.refuse(`The state of protected files could not be saved before this command: ${text(thrown)}`, UNREADABLE_REDIRECT);
    }
  }

  async verify(result: ToolResult): Promise<DriftReport> {
    let rules: readonly Rule[] = [];
    try {
      if (!runsShell(result)) return NOTHING;
      rules = this.rules();
      let stored: unknown;
      let problem: string | undefined;
      try {
        stored = result.callId === undefined ? undefined : await this.snapshots.take(result.callId.value);
      } catch (thrown) {
        problem = `it could not be read: ${text(thrown)}`;
      }
      if (rules.length === 0) return NOTHING;
      if (problem === undefined && stored === undefined) return await this.unverified(result, rules, "none was found for it", false);
      const before = problem === undefined ? await this.checked(stored, rules) : { ok: false as const, error: problem };
      if (!before.ok) return await this.unverified(result, rules, before.error, true);
      return await this.undo(result, before.value, rules);
    } catch (thrown) {
      const message = `Protected files could not be checked after this command: ${text(thrown)}. Check them by hand against version control.`;
      return { changed: [], restored: false, message, record: record(result, message, rules[0], "could not be checked after a shell command") };
    }
  }

  /** Which of `rules` watch a path, worked out now from the composed rules, never from what a snapshot stored. */
  private watching(rules: readonly Rule[]): Watching {
    const paths = rules.map(({ rule }) => rule);
    return (path) => this.files.rulesWatching(paths, path);
  }

  /** The watched paths from the composed protected paths, each watched for the path gate. */
  private rules(): readonly Rule[] {
    const watched = watchedRulesOf(this.composition, this.protectedPaths);
    if (!watched.ok) throw new Error(watched.error);
    return watched.value;
  }

  private async hash(rules: readonly Rule[]): Promise<Result<WatchedHashes>> {
    try {
      return await this.files.hash(rules.map(({ rule }) => rule));
    } catch (thrown) {
      return { ok: false, error: text(thrown) };
    }
  }

  /** The watched files at `commit`, or none when there is no commit. */
  private async committed(rules: readonly Rule[], commit: string | null): Promise<Result<WatchedHashes>> {
    return commit === null
      ? { ok: true, value: {} }
      : this.files.committed(
          rules.map(({ rule }) => rule),
          commit,
        );
  }

  /** The watched files now, and how to put each back: from the commit, from a copy within the limits, or not at all. */
  private async capture(rules: readonly Rule[]): Promise<Result<Snapshot>> {
    const hashed = await this.hash(rules);
    if (!hashed.ok) return hashed;
    const head = await this.files.head();
    if (!head.ok) return head;
    const committed = await this.committed(rules, head.value);
    if (!committed.ok) return committed;
    let budget = this.limits.total;
    const files: Record<string, SnapshotFile> = {};
    for (const [path, file] of Object.entries(hashed.value).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (committed.value[path]?.hash === file.hash && file.link !== true) files[path] = { ...file, kept: { from: "commit" } };
      else if (file.link === true || file.size > this.limits.perFile || file.size > budget) files[path] = { ...file, kept: { from: "nowhere" } };
      else {
        const copy = await this.files.copy(path);
        if (!copy.ok) return copy;
        budget -= copy.value.size;
        files[path] = { hash: copy.value.hash, size: copy.value.size, rule: file.rule, ...(file.rules === undefined ? {} : { rules: file.rules }), kept: { from: "copy", content: copy.value.content, executable: copy.value.executable } };
      }
    }
    return Snapshot.parse({ commit: head.value, files }, rules.length);
  }

  /** A stored snapshot, checked: its form (Snapshot.parse), then every copy against its hash and every file kept by the commit against it. */
  private async checked(stored: unknown, rules: readonly Rule[]): Promise<Result<Snapshot>> {
    const parsed = Snapshot.parse(stored, rules.length);
    if (!parsed.ok) return parsed;
    const { commit, files } = parsed.value;
    const byCommit = Object.values(files).some((file) => file.kept.from === "commit");
    const committed = byCommit ? await this.committed(rules, commit) : { ok: true as const, value: {} as WatchedHashes };
    if (!committed.ok) return { ok: false, error: `its commit cannot be read: ${committed.error}` };
    for (const [path, file] of Object.entries(files)) {
      if (file.kept.from === "commit" && (commit === null || committed.value[path]?.hash !== file.hash)) return { ok: false, error: `${shown(path)} does not match the commit it was kept by` };
      if (file.kept.from !== "copy") continue;
      const copy = await digest(file.kept.content);
      if (copy === undefined || copy.hash !== file.hash || copy.size !== file.size) return { ok: false, error: `the copy of ${shown(path)} does not match its hash` };
    }
    return parsed;
  }

  /** Puts back what the command changed, from the snapshot, records it and says what happened. */
  private async undo(result: ToolResult, before: Snapshot, rules: readonly Rule[]): Promise<DriftReport> {
    const after = await this.hash(rules);
    if (!after.ok) {
      const message = `Protected files could not be checked after this command: ${after.error}. Check them by hand against version control.`;
      return { changed: [], restored: false, message, record: record(result, message, rules[0], "could not be checked after a shell command") };
    }
    const changed = forbidden(changes(before.files, after.value), this.watching(rules), rules);
    if (changed.length === 0) return NOTHING;
    const failures = new Set<string>();
    const restored: string[] = [];
    // What the command created is moved aside, never deleted: a snapshot entry removed by tampering must not cost a file.
    const created = changed.filter(({ path }) => before.files[path] === undefined).map(({ path }) => path);
    let movedTo: string | undefined;
    if (created.length > 0) {
      const moved = await this.quarantine(created);
      if (moved.ok) {
        movedTo = moved.value;
        restored.push(...created);
      } else failures.add(`what it created could not be moved aside: ${moved.error}`);
    }
    for (const { path } of changed) {
      if (before.files[path] === undefined) continue;
      const from = restoreFrom(before, path);
      if (from === undefined) {
        failures.add(before.files[path]?.link === true ? `${shown(path)} was a link, which is not kept, so it was left as the command left it` : `${shown(path)} was too large to keep a copy of, so it was left as the command left it`);
        continue;
      }
      const failure = await this.restore(path, from);
      if (failure === undefined) restored.push(path);
      else failures.add(failure);
    }
    if (restored.length > 0) {
      const again = await this.hash(rules);
      if (!again.ok) failures.add(`the files could not be checked after restoring: ${again.error}`);
      else {
        const different = restored.filter((path) => again.value[path]?.hash !== before.files[path]?.hash);
        if (different.length > 0) failures.add(`after restoring, ${different.map(shown).join(", ")} still ${different.length === 1 ? "differs" : "differ"} from before the command`);
      }
    }
    const groups = describe(changed, this.watching(rules), rules) + (movedTo === undefined ? "" : ` What it created was moved, not deleted, to ${movedTo}.`);
    const message =
      failures.size === 0
        ? `This command changed protected files, and they were restored: ${groups}`
        : `This command changed protected files, and restoring them FAILED (${shown([...failures].join("; "))}); restore them by hand: ${groups}`;
    const first = rules[Math.min(...changed.map((change) => ruleOf(change, this.watching(rules), rules)))];
    return { changed, restored: failures.size === 0, message, record: record(result, message, first, failures.size === 0 ? "changed by a shell command; restored" : "changed by a shell command; restore failed") };
  }

  /** Where the created files went, or why they could not be moved. */
  private async quarantine(paths: readonly string[]): Promise<Result<string>> {
    try {
      return await this.files.quarantine(paths);
    } catch (thrown) {
      return { ok: false, error: text(thrown) };
    }
  }

  /** Why putting one file back failed, or undefined. */
  private async restore(path: string, from: RestoreFrom): Promise<string | undefined> {
    try {
      const restored = await this.files.restore(path, from);
      return restored.ok ? undefined : restored.error;
    } catch (thrown) {
      return text(thrown);
    }
  }

  /**
   * Without a snapshot to trust: compare the watched files with the commit,
   * say so loudly and record it, restoring nothing. A snapshot simply not
   * found, with nothing different from the commit, says nothing.
   */
  private async unverified(result: ToolResult, rules: readonly Rule[], why: string, altered: boolean): Promise<DriftReport> {
    const head = await this.files.head();
    let changed: FileChange[] = [];
    let first = rules[0];
    let found: string;
    if (!head.ok || head.value === null) found = `Protected files could not be compared with a commit: ${head.ok ? "the project has no commit" : head.error}.`;
    else {
      const committed = await this.committed(rules, head.value);
      const now = await this.hash(rules);
      if (!committed.ok) found = `Protected files could not be compared with the last commit: ${committed.error}.`;
      else if (!now.ok) found = `Protected files could not be read: ${now.error}.`;
      else {
        changed = forbidden(changes(committed.value, now.value), this.watching(rules), rules);
        if (changed.length === 0 && !altered) return NOTHING;
        if (changed.length > 0) first = rules[Math.min(...changed.map((change) => ruleOf(change, this.watching(rules), rules)))];
        found = changed.length === 0 ? "Protected files match the last commit." : `Protected files that differ from the last commit: ${describe(changed, this.watching(rules), rules)}`;
      }
    }
    const message = `The snapshot for this command was missing or altered (${why}), so its changes cannot be told from earlier work and nothing was restored. ${found} Check them against version control.`;
    return { changed, restored: false, message, record: record(result, message, first, "snapshot missing or altered") };
  }
}

/** What to record of a check after a shell command: a refusal naming the path gate and the command when a rule is known. */
function record(result: ToolResult, message: string, rule: Rule | undefined, note: string): DriftReport["record"] {
  const effect = result.effects.find((e): e is ExecuteEffect => e.kind === "execute") ?? null;
  return { verdict: Verdict.refuse(message, rule?.rule.redirect ?? CHECK_REDIRECT), refusedBy: rule === undefined ? null : { effect }, note };
}

/** Where a changed file that existed before comes back from: its copy or the snapshot's commit; undefined when it cannot. */
function restoreFrom(before: Snapshot, path: string): RestoreFrom | undefined {
  const was = before.files[path];
  if (was === undefined) return undefined;
  if (was.kept.from === "copy") return { from: "copy", content: was.kept.content, executable: was.kept.executable };
  if (was.kept.from === "commit" && before.commit !== null) return { from: "commit", commit: before.commit };
  return undefined;
}

/** The watched files that differ between two hashings, sorted by path. */
function changes(before: WatchedHashes, after: WatchedHashes): FileChange[] {
  const out: FileChange[] = [];
  for (const [path, file] of Object.entries(before)) {
    const now = after[path];
    if (now === undefined) out.push({ path, change: "deleted" });
    else if (now.hash !== file.hash) out.push({ path, change: "modified" });
  }
  for (const path of Object.keys(after)) if (before[path] === undefined) out.push({ path, change: "created" });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What each kind of change is, in a watched path's terms. */
const KIND: Readonly<Record<FileChange["change"], WatchedChange>> = { created: "create", modified: "modify", deleted: "delete" };

/** Which watched paths watch a path, by index into the rules, in order. */
type Watching = (path: string) => readonly number[];

/** The rules watching a changed file that forbid its change, in order: any one forbidding it is enough. */
function forbiddingRules(change: FileChange, watching: Watching, rules: readonly Rule[]): number[] {
  return watching(change.path).filter((index) => rules[index]?.rule.changes.includes(KIND[change.change]) === true);
}

/** The changes some path watching each file forbids; any other change is the command's to make. */
function forbidden(changed: readonly FileChange[], watching: Watching, rules: readonly Rule[]): FileChange[] {
  return changed.filter((change) => forbiddingRules(change, watching, rules).length > 0);
}

/** The rule a change is reported under: the first that forbids it, else the first that watches the file. */
function ruleOf(change: FileChange, watching: Watching, rules: readonly Rule[]): number {
  return forbiddingRules(change, watching, rules)[0] ?? watching(change.path)[0] ?? 0;
}

/** For each rule, in rule order: "<its files and what they became> — protected because <why>. <what to do instead>." */
function describe(changed: readonly FileChange[], watching: Watching, rules: readonly Rule[]): string {
  const groups = new Map<number, FileChange[]>();
  for (const change of changed) {
    const index = ruleOf(change, watching, rules);
    groups.set(index, [...(groups.get(index) ?? []), change]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, files]) => {
      const rule = rules[index]?.rule;
      const what = files.map((f) => `${shown(f.path)} was ${f.change}`).join(", ");
      return rule === undefined ? sentence(what) : `${what} — protected because ${sentence(rule.why)} ${sentence(rule.redirect)}`;
    })
    .join(" ");
}
