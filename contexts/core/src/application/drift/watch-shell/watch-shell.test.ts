import { describe, expect, test } from "bun:test";
import { Composition, contribution, corePack, type Decision, definePack, packIdsFor, type Result, ToolResult, ToolUse, type WatchedPath } from "bounded/domain";
import type { Clock, DecisionLog } from "../../judging/judge-event/judge-event.contract.ts";
import type { ShellSnapshots, WatchedFiles, WatchedHashes } from "./watch-shell.contract.ts";
import { WatchShellHandler } from "./watch-shell.handler.ts";

const clock: Clock = { now: () => "2026-10-08T12:00:00.000Z" };
const RULES_REDIRECT = "Change the generator's input instead";

/** Files in memory: `committed` is version control, `working` the files now. */
class FakeFiles implements WatchedFiles {
  readonly working: Map<string, string>;
  hashFailure: string | undefined;
  restoreFailure: string | undefined;
  restored: string[] = [];
  constructor(private readonly committed: Record<string, string>) {
    this.working = new Map(Object.entries(committed));
  }

  async hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>> {
    if (this.hashFailure !== undefined) return { ok: false, error: this.hashFailure };
    const out: Record<string, { hash: string; rule: number }> = {};
    for (const [path, content] of this.working) {
      const rule = rules.findIndex((r) => new Bun.Glob(r.match).match(path) && !(r.except ?? []).some((e) => new Bun.Glob(e).match(path)));
      if (rule >= 0) out[path] = { hash: `#${content}`, rule };
    }
    return { ok: true, value: out };
  }

  async restore(paths: readonly string[]): Promise<Result<void>> {
    if (this.restoreFailure !== undefined) return { ok: false, error: this.restoreFailure };
    for (const path of paths) {
      this.restored.push(path);
      const content = this.committed[path];
      if (content === undefined) this.working.delete(path);
      else this.working.set(path, content);
    }
    return { ok: true, value: undefined };
  }
}

class FakeSnapshots implements ShellSnapshots {
  readonly kept = new Map<string, WatchedHashes>();
  async save(callId: string, hashes: WatchedHashes): Promise<void> {
    this.kept.set(callId, hashes);
  }
  async take(callId: string): Promise<WatchedHashes | undefined> {
    const hashes = this.kept.get(callId);
    this.kept.delete(callId);
    return hashes;
  }
}

class FakeLog implements DecisionLog {
  readonly decisions: Decision[] = [];
  async record(decision: Decision): Promise<void> {
    this.decisions.push(decision);
  }
}

const rules = definePack({
  id: packIdsFor("test-packs")("rules"),
  dependsOn: [corePack],
  contributes: [
    contribution(corePack.points.watchedPaths, [
      { match: "generated/**", except: ["generated/README.md"], why: "generated/ is written by the generator", redirect: RULES_REDIRECT },
      { match: "bounded.config.ts", why: "the configuration decides what agents may do", redirect: "Ask the project's owner" },
    ]),
  ],
});
const composed = Composition.compose([rules, corePack], [rules, corePack]);
if (!composed.ok) throw new Error(composed.error);
const composition = composed.value;

const shell = { role: "builder", tool: "shell", effects: [{ kind: "execute", command: "make" }], callId: "c1" };
function use(raw: object): ToolUse {
  const parsed = ToolUse.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
function result(raw: object = {}): ToolResult {
  const parsed = ToolResult.parse({ ...shell, kind: "tool-result", ok: true, ...raw });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function setup() {
  const files = new FakeFiles({ "generated/a.ts": "a", "generated/README.md": "r", "bounded.config.ts": "c", "src/b.ts": "b" });
  const snapshots = new FakeSnapshots();
  const log = new FakeLog();
  return { files, snapshots, log, watch: new WatchShellHandler(composition, files, snapshots, log, clock) };
}

describe("WatchShellHandler — before a shell command", () => {
  test("hashes the watched files and keeps them under the call's id, then allows", async () => {
    const { watch, snapshots } = setup();
    expect((await watch.snapshot(use(shell))).kind).toBe("allow");
    expect(Object.keys(snapshots.kept.get("c1") ?? {}).sort()).toEqual(["bounded.config.ts", "generated/a.ts"]);
  });

  test("a call without a shell command needs no snapshot", async () => {
    const { watch, snapshots } = setup();
    expect((await watch.snapshot(use({ role: null, tool: "edit", effects: [{ kind: "write", path: "src/b.ts", change: "modify" }] }))).kind).toBe("allow");
    expect(snapshots.kept.size).toBe(0);
  });

  test("a shell command without a call id is refused: its effects could not be checked afterwards", async () => {
    const { watch } = setup();
    const { callId: _id, ...anonymous } = shell;
    expect<unknown>(await watch.snapshot(use(anonymous))).toEqual({
      kind: "refuse",
      reason: "A shell command must carry its tool call id, so the protected files it may change can be checked afterwards",
      redirect: "Report this to the maintainers of the host adapter; the command is refused meanwhile",
    });
  });

  test("if the watched files cannot be hashed, the command is refused", async () => {
    const { watch, files } = setup();
    files.hashFailure = "permission denied";
    expect<unknown>(await watch.snapshot(use(shell))).toEqual({
      kind: "refuse",
      reason: "Protected files could not be checked before this command: permission denied",
      redirect: "Fix what stops protected files from being read; until then shell commands are refused",
    });
  });
});

describe("WatchShellHandler — after a shell command", () => {
  test("nothing changed: nothing to say, nothing recorded", async () => {
    const { watch, log } = setup();
    await watch.snapshot(use(shell));
    expect(await watch.verify(result())).toEqual({ changed: [], restored: true, message: null });
    expect(log.decisions).toEqual([]);
  });

  test("a changed, a deleted and a created file are put back, recorded and reported, naming the rule's why and redirect", async () => {
    const { watch, files, log } = setup();
    await watch.snapshot(use(shell));
    files.working.set("generated/a.ts", "tampered");
    files.working.delete("bounded.config.ts");
    files.working.set("generated/new.ts", "created");
    files.working.set("generated/README.md", "not watched");
    const check = await watch.verify(result());
    expect(check.changed).toEqual([
      { path: "bounded.config.ts", change: "deleted" },
      { path: "generated/a.ts", change: "modified" },
      { path: "generated/new.ts", change: "created" },
    ]);
    expect(check.restored).toBe(true);
    expect(check.message).toBe(
      "This command changed protected files, and they were restored: generated/a.ts was modified, generated/new.ts was created. generated/ is written by the generator. Instead: Change the generator's input instead. bounded.config.ts was deleted. the configuration decides what agents may do. Instead: Ask the project's owner.",
    );
    expect(files.working.get("generated/a.ts")).toBe("a");
    expect(files.working.get("bounded.config.ts")).toBe("c");
    expect(files.working.has("generated/new.ts")).toBe(false);
    expect(files.working.get("generated/README.md")).toBe("not watched");
    expect(log.decisions.length).toBe(1);
    expect(log.decisions[0]?.event).toBe("tool-result");
    expect(log.decisions[0]?.note).toBe("changed by a shell command; restored");
    expect<unknown>(log.decisions[0]?.verdict).toEqual({ kind: "refuse", reason: check.message, redirect: RULES_REDIRECT, pack: "test-packs/rules", effect: "execute `make`" });
  });

  test("a restore that fails is reported loudly and recorded", async () => {
    const { watch, files, log } = setup();
    await watch.snapshot(use(shell));
    files.working.set("generated/a.ts", "tampered");
    files.restoreFailure = "not a git repository";
    const check = await watch.verify(result());
    expect(check.restored).toBe(false);
    expect(check.message).toBe(
      "This command changed protected files, and restoring them FAILED (not a git repository); restore them from version control by hand: generated/a.ts was modified. generated/ is written by the generator. Instead: Change the generator's input instead.",
    );
    expect(log.decisions[0]?.note).toBe("changed by a shell command; restore failed");
  });

  test("a restore that leaves a file different from before the command is a failed restore", async () => {
    const { watch, files } = setup();
    files.working.set("generated/a.ts", "uncommitted edit");
    await watch.snapshot(use(shell));
    files.working.set("generated/a.ts", "tampered");
    const check = await watch.verify(result());
    expect(check.restored).toBe(false);
    expect(check.message?.startsWith("This command changed protected files, and restoring them FAILED (after restoring, generated/a.ts still differs from before the command: it had changes not in version control)")).toBe(true);
  });

  test("if the watched files cannot be hashed afterwards, that is reported loudly and recorded", async () => {
    const { watch, files, log } = setup();
    await watch.snapshot(use(shell));
    files.hashFailure = "disk gone";
    expect(await watch.verify(result())).toEqual({
      changed: [],
      restored: false,
      message: "Protected files could not be checked after this command: disk gone. Check them by hand against version control.",
    });
    expect(log.decisions[0]?.note).toBe("could not be checked after a shell command");
  });

  test("a result with no snapshot (no shell command, or no call id) has nothing to check", async () => {
    const { watch } = setup();
    expect(await watch.verify(result({ callId: "never-seen" }))).toEqual({ changed: [], restored: true, message: null });
    const { callId: _id, ...anonymous } = { ...shell, kind: "tool-result", ok: true };
    const parsed = ToolResult.parse(anonymous);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(await watch.verify(parsed.value)).toEqual({ changed: [], restored: true, message: null });
  });
});
