import { type Composition, Decision, type ExecuteEffect, type PackId, type Result, type ToolResult, type ToolUse, Verdict, type WatchedPath, watchedPathsOf } from "bounded/domain";
import type { Clock, DecisionIds, DecisionLog } from "../../judging/judge-event/judge-event.contract.ts";
import type { Change, DriftCheck, Kept, RestoreFrom, ShellSnapshots, Snapshot, SnapshotFile, WatchedFiles, WatchedHashes, WatchShell } from "./watch-shell.contract.ts";

const NOTHING: DriftCheck = Object.freeze({ changed: Object.freeze([]), restored: true, message: null });
const UNREADABLE_REDIRECT = "Fix what stops protected files from being read; until then shell commands are refused";
const CHECK_REDIRECT = "Check the protected files by hand against version control";
const SHA256 = /^[0-9a-f]{64}$/;

/** How much a snapshot copies of the watched files that version control does not hold: 1 MB a file, 10 MB in all. */
export const COPY_LIMITS = Object.freeze({ perFile: 1_000_000, total: 10_000_000 });

function text(thrown: unknown): string {
  try {
    return String(thrown instanceof Error ? (thrown.message as unknown) : thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

/** A watched rule and the pack that contributed it. */
interface Rule {
  readonly rule: WatchedPath;
  readonly from: PackId;
}

const runsShell = (call: ToolUse | ToolResult): boolean => call.effects.some((effect) => effect.kind === "execute");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
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
  private readonly ids: DecisionIds;
  private readonly limits: { readonly perFile: number; readonly total: number };

  constructor(
    private readonly composition: Composition,
    private readonly files: WatchedFiles,
    private readonly snapshots: ShellSnapshots,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
    options: { readonly ids?: DecisionIds; readonly limits?: { readonly perFile: number; readonly total: number } } = {},
  ) {
    this.ids = options.ids ?? { next: () => crypto.randomUUID() };
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
      await this.snapshots.save(call.callId, captured.value);
      return Verdict.allow;
    } catch (thrown) {
      return Verdict.refuse(`The state of protected files could not be saved before this command: ${text(thrown)}`, UNREADABLE_REDIRECT);
    }
  }

  async verify(result: ToolResult): Promise<DriftCheck> {
    let rules: readonly Rule[] = [];
    try {
      if (!runsShell(result)) return NOTHING;
      rules = this.rules();
      let stored: unknown;
      let problem: string | undefined;
      try {
        stored = result.callId === undefined ? undefined : await this.snapshots.take(result.callId);
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
      await this.record(result, message, rules[0], "could not be checked after a shell command");
      return { changed: [], restored: false, message };
    }
  }

  /** The composed watched paths, with the pack each came from. */
  private rules(): readonly Rule[] {
    const watched = watchedPathsOf(this.composition);
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
      if (committed.value[path]?.hash === file.hash) files[path] = { ...file, kept: { from: "commit" } };
      else if (file.size > this.limits.perFile || file.size > budget) files[path] = { ...file, kept: { from: "nowhere" } };
      else {
        const copy = await this.files.copy(path);
        if (!copy.ok) return copy;
        budget -= copy.value.size;
        files[path] = { hash: copy.value.hash, size: copy.value.size, rule: file.rule, kept: { from: "copy", content: copy.value.content } };
      }
    }
    return { ok: true, value: { commit: head.value, files } };
  }

  /** A stored snapshot, checked: its form, every hash, every copy against its hash and every file kept by the commit against it. */
  private async checked(stored: unknown, rules: readonly Rule[]): Promise<Result<Snapshot>> {
    const altered = (why: string): Result<Snapshot> => ({ ok: false, error: why });
    if (!isRecord(stored) || !isRecord(stored.files) || !(stored.commit === null || typeof stored.commit === "string")) return altered("it is not a snapshot");
    const commit = stored.commit;
    const byCommit = Object.values(stored.files).some((file) => isRecord(file) && isRecord(file.kept) && file.kept.from === "commit");
    const committed = byCommit ? await this.committed(rules, commit) : { ok: true as const, value: {} as WatchedHashes };
    if (!committed.ok) return altered(`its commit cannot be read: ${committed.error}`);
    const files: Record<string, SnapshotFile> = {};
    for (const [path, file] of Object.entries(stored.files)) {
      if (!isRecord(file) || typeof file.hash !== "string" || !SHA256.test(file.hash)) return altered(`${path} has a hash that is not a SHA-256`);
      const { hash, size, rule, kept } = file;
      if (!isCount(size) || !isCount(rule) || rule >= rules.length || !isRecord(kept)) return altered(`${path} is not a snapshot's file`);
      let keptAs: Kept;
      if (kept.from === "commit") {
        if (commit === null || committed.value[path]?.hash !== hash) return altered(`${path} does not match the commit it was kept by`);
        keptAs = { from: "commit" };
      } else if (kept.from === "copy") {
        const copy = typeof kept.content === "string" ? await digest(kept.content) : undefined;
        if (copy === undefined || copy.hash !== hash || copy.size !== size) return altered(`the copy of ${path} does not match its hash`);
        keptAs = { from: "copy", content: kept.content as string };
      } else if (kept.from === "nowhere") keptAs = { from: "nowhere" };
      else return altered(`${path} is not a snapshot's file`);
      files[path] = { hash, size, rule, kept: keptAs };
    }
    return { ok: true, value: { commit, files } };
  }

  /** Puts back what the command changed, from the snapshot, records it and says what happened. */
  private async undo(result: ToolResult, before: Snapshot, rules: readonly Rule[]): Promise<DriftCheck> {
    const after = await this.hash(rules);
    if (!after.ok) {
      const message = `Protected files could not be checked after this command: ${after.error}. Check them by hand against version control.`;
      await this.record(result, message, rules[0], "could not be checked after a shell command");
      return { changed: [], restored: false, message };
    }
    const changed = changes(before.files, after.value);
    if (changed.length === 0) return NOTHING;
    const failures = new Set<string>();
    const restored: string[] = [];
    for (const { path } of changed) {
      const from = restoreFrom(before, path);
      if (from === undefined) {
        failures.add(`${path} was too large to keep a copy of, so it was left as the command left it`);
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
        if (different.length > 0) failures.add(`after restoring, ${different.join(", ")} still ${different.length === 1 ? "differs" : "differ"} from before the command`);
      }
    }
    const groups = describe(changed, before.files, after.value, rules);
    const message =
      failures.size === 0
        ? `This command changed protected files, and they were restored: ${groups}`
        : `This command changed protected files, and restoring them FAILED (${[...failures].join("; ")}); restore them by hand: ${groups}`;
    const first = rules[Math.min(...changed.map((change) => ruleOf(change, before.files, after.value)))];
    await this.record(result, message, first, failures.size === 0 ? "changed by a shell command; restored" : "changed by a shell command; restore failed");
    return { changed, restored: failures.size === 0, message };
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
  private async unverified(result: ToolResult, rules: readonly Rule[], why: string, altered: boolean): Promise<DriftCheck> {
    const head = await this.files.head();
    let changed: Change[] = [];
    let first = rules[0];
    let found: string;
    if (!head.ok || head.value === null) found = `Protected files could not be compared with a commit: ${head.ok ? "the project has no commit" : head.error}.`;
    else {
      const committed = await this.committed(rules, head.value);
      const now = await this.hash(rules);
      if (!committed.ok) found = `Protected files could not be compared with the last commit: ${committed.error}.`;
      else if (!now.ok) found = `Protected files could not be read: ${now.error}.`;
      else {
        changed = changes(committed.value, now.value);
        if (changed.length === 0 && !altered) return NOTHING;
        if (changed.length > 0) first = rules[Math.min(...changed.map((change) => ruleOf(change, committed.value, now.value)))];
        found = changed.length === 0 ? "Protected files match the last commit." : `Protected files that differ from the last commit: ${describe(changed, committed.value, now.value, rules)}`;
      }
    }
    const message = `The snapshot for this command was missing or altered (${why}), so its changes cannot be told from earlier work and nothing was restored. ${found} Check them against version control.`;
    await this.record(result, message, first, "snapshot missing or altered");
    return { changed, restored: false, message };
  }

  private async record(result: ToolResult, message: string, rule: Rule | undefined, note: string): Promise<void> {
    const effect = result.effects.find((e): e is ExecuteEffect => e.kind === "execute") ?? null;
    const verdict = Verdict.refuse(message, rule?.rule.redirect ?? CHECK_REDIRECT);
    try {
      const judgement = { verdict, refusedBy: rule === undefined ? null : { pack: rule.from, effect } };
      await this.log.record(Decision.of(this.ids.next(), this.clock.now(), result, judgement, note));
    } catch {
      // The message already says what happened; a log that cannot record it changes nothing more.
    }
  }
}

/** Where a changed file comes back from: its copy, the snapshot's commit, or nowhere when it did not exist; undefined when it cannot. */
function restoreFrom(before: Snapshot, path: string): RestoreFrom | undefined {
  const was = before.files[path];
  if (was === undefined) return { from: "absent" };
  if (was.kept.from === "copy") return { from: "copy", content: was.kept.content };
  if (was.kept.from === "commit" && before.commit !== null) return { from: "commit", commit: before.commit };
  return undefined;
}

/** The watched files that differ between two hashings, sorted by path. */
function changes(before: WatchedHashes, after: WatchedHashes): Change[] {
  const out: Change[] = [];
  for (const [path, file] of Object.entries(before)) {
    const now = after[path];
    if (now === undefined) out.push({ path, change: "deleted" });
    else if (now.hash !== file.hash) out.push({ path, change: "modified" });
  }
  for (const path of Object.keys(after)) if (before[path] === undefined) out.push({ path, change: "created" });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function ruleOf(change: Change, before: WatchedHashes, after: WatchedHashes): number {
  return (before[change.path] ?? after[change.path])?.rule ?? 0;
}

/** For each rule, in rule order: its files and what they became, why they are watched, then what to do instead. */
function describe(changed: readonly Change[], before: WatchedHashes, after: WatchedHashes, rules: readonly Rule[]): string {
  const groups = new Map<number, Change[]>();
  for (const change of changed) {
    const index = ruleOf(change, before, after);
    groups.set(index, [...(groups.get(index) ?? []), change]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, files]) => {
      const rule = rules[index]?.rule;
      const what = sentence(files.map((f) => `${f.path} was ${f.change}`).join(", "));
      return rule === undefined ? what : `${what} ${sentence(rule.why)} ${sentence(rule.redirect)}`;
    })
    .join(" ");
}
