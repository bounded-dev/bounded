import { type Composition, Decision, watchedPathsOf, type ExecuteEffect, type PackId, type Result, type ToolResult, type ToolUse, Verdict, type WatchedPath } from "bounded/domain";
import type { Clock, DecisionIds, DecisionLog } from "../../judging/judge-event/judge-event.contract.ts";
import type { Change, DriftCheck, ShellSnapshots, WatchedFiles, WatchedHashes, WatchShell } from "./watch-shell.contract.ts";

const NOTHING: DriftCheck = Object.freeze({ changed: Object.freeze([]), restored: true, message: null });
const UNREADABLE_REDIRECT = "Fix what stops protected files from being read; until then shell commands are refused";

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

export class WatchShellHandler implements WatchShell {
  private readonly ids: DecisionIds;

  constructor(
    private readonly composition: Composition,
    private readonly files: WatchedFiles,
    private readonly snapshots: ShellSnapshots,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
    options: { readonly ids?: DecisionIds } = {},
  ) {
    this.ids = options.ids ?? { next: () => crypto.randomUUID() };
  }

  async snapshot(call: ToolUse): Promise<Verdict> {
    try {
      if (!call.effects.some((effect) => effect.kind === "execute")) return Verdict.allow;
      const rules = this.rules();
      if (rules.length === 0) return Verdict.allow;
      if (call.callId === undefined) {
        return Verdict.refuse(
          "A shell command must carry its tool call id, so the protected files it may change can be checked afterwards",
          "Report this to the maintainers of the host adapter; the command is refused meanwhile",
        );
      }
      const hashed = await this.hash(rules);
      if (!hashed.ok) return Verdict.refuse(`Protected files could not be checked before this command: ${hashed.error}`, UNREADABLE_REDIRECT);
      await this.snapshots.save(call.callId, hashed.value);
      return Verdict.allow;
    } catch (thrown) {
      return Verdict.refuse(`The state of protected files could not be saved before this command: ${text(thrown)}`, UNREADABLE_REDIRECT);
    }
  }

  async verify(result: ToolResult): Promise<DriftCheck> {
    try {
      if (result.callId === undefined) return NOTHING;
      const before = await this.snapshots.take(result.callId);
      if (before === undefined) return NOTHING;
      const rules = this.rules();
      const after = await this.hash(rules);
      if (!after.ok) {
        const message = `Protected files could not be checked after this command: ${after.error}. Check them by hand against version control.`;
        await this.record(result, message, rules[0], "could not be checked after a shell command");
        return { changed: [], restored: false, message };
      }
      const changed = changes(before, after.value);
      if (changed.length === 0) return NOTHING;
      const failure = await this.restore(changed, before, rules);
      const groups = describe(changed, before, after.value, rules);
      const message =
        failure === undefined
          ? `This command changed protected files, and they were restored: ${groups}`
          : `This command changed protected files, and restoring them FAILED (${failure}); restore them from version control by hand: ${groups}`;
      const first = rules[Math.min(...changed.map((change) => ruleOf(change, before, after.value)))];
      await this.record(result, message, first, failure === undefined ? "changed by a shell command; restored" : "changed by a shell command; restore failed");
      return { changed, restored: failure === undefined, message };
    } catch (thrown) {
      return { changed: [], restored: false, message: `Protected files could not be checked after this command: ${text(thrown)}. Check them by hand against version control.` };
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

  /** Why putting the files back failed, or undefined when they are exactly as before. */
  private async restore(changed: readonly Change[], before: WatchedHashes, rules: readonly Rule[]): Promise<string | undefined> {
    let restored: Result<void>;
    try {
      restored = await this.files.restore(changed.map((c) => c.path));
    } catch (thrown) {
      return text(thrown);
    }
    if (!restored.ok) return restored.error;
    const again = await this.hash(rules);
    if (!again.ok) return `the files could not be checked after restoring: ${again.error}`;
    const different = changes(before, again.value).map((c) => c.path);
    if (different.length === 0) return undefined;
    const them = different.length === 1 ? "it" : "they";
    return `after restoring, ${different.join(", ")} still ${different.length === 1 ? "differs" : "differ"} from before the command: ${them} had changes not in version control`;
  }

  private async record(result: ToolResult, message: string, rule: Rule | undefined, note: string): Promise<void> {
    const effect = result.effects.find((e): e is ExecuteEffect => e.kind === "execute") ?? null;
    const verdict = Verdict.refuse(message, rule?.rule.redirect ?? "Check the protected files by hand against version control");
    try {
      const judgement = { verdict, refusedBy: rule === undefined ? null : { pack: rule.from, effect } };
      await this.log.record(Decision.of(this.ids.next(), this.clock.now(), result, judgement, note));
    } catch {
      // The message already says what happened; a log that cannot record it changes nothing more.
    }
  }
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

/** For each rule, in rule order: its files and what they became, why they are watched and what to do instead. */
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
      const what = files.map((f) => `${f.path} was ${f.change}`).join(", ");
      return rule === undefined ? `${what}.` : `${what}. ${rule.why}. Instead: ${rule.redirect}.`;
    })
    .join(" ");
}
