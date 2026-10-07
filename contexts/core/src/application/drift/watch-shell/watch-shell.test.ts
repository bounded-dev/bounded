import { describe, expect, test } from "bun:test";
import { Composition, contribution, corePack, type Decision, definePack, packIdsFor, type Result, ToolResult, ToolUse, type WatchedPath } from "bounded/domain";
import type { Clock, DecisionLog } from "../../judging/judge-event/judge-event.contract.ts";
import type { RestoreFrom, ShellSnapshots, Snapshot, WatchedFile, WatchedFiles, WatchedHashes } from "./watch-shell.contract.ts";
import { WatchShellHandler } from "./watch-shell.handler.ts";

const clock: Clock = { now: () => "2026-10-08T12:00:00.000Z" };
const RULES_REDIRECT = "Change the generator's input instead";

const sha = (content: string): string => new Bun.CryptoHasher("sha256").update(content).digest("hex");
const base64 = (content: string): string => Buffer.from(content).toString("base64");
const COMMIT = "c0";

/** Files in memory: `committed` is version control at commit c0, `working` the files now. */
class FakeFiles implements WatchedFiles {
  readonly working: Map<string, string>;
  hashFailure: string | undefined;
  restoreFailure: string | undefined;
  gitThrows: string | undefined;
  restored: string[] = [];
  constructor(private readonly committedFiles: Record<string, string>) {
    this.working = new Map(Object.entries(committedFiles));
  }

  private hashes(files: Iterable<[string, string]>, rules: readonly WatchedPath[]): WatchedHashes {
    const out: Record<string, WatchedFile> = {};
    for (const [path, content] of files) {
      const rule = rules.findIndex((r) => new Bun.Glob(r.match).match(path) && !(r.except ?? []).some((e) => new Bun.Glob(e).match(path)));
      if (rule >= 0) out[path] = { hash: sha(content), size: content.length, rule };
    }
    return out;
  }

  async hash(rules: readonly WatchedPath[]): Promise<Result<WatchedHashes>> {
    if (this.hashFailure !== undefined) return { ok: false, error: this.hashFailure };
    return { ok: true, value: this.hashes(this.working, rules) };
  }

  async head(): Promise<Result<string | null>> {
    if (this.gitThrows !== undefined) throw new Error(this.gitThrows);
    return { ok: true, value: COMMIT };
  }

  async committed(rules: readonly WatchedPath[], commit: string): Promise<Result<WatchedHashes>> {
    if (this.gitThrows !== undefined) throw new Error(this.gitThrows);
    if (commit !== COMMIT) return { ok: false, error: `no commit ${commit}` };
    return { ok: true, value: this.hashes(Object.entries(this.committedFiles), rules) };
  }

  async copy(path: string): Promise<Result<{ hash: string; size: number; content: string }>> {
    const content = this.working.get(path);
    if (content === undefined) return { ok: false, error: `${path} does not exist` };
    return { ok: true, value: { hash: sha(content), size: content.length, content: base64(content) } };
  }

  async restore(path: string, from: RestoreFrom): Promise<Result<void>> {
    if (this.restoreFailure !== undefined) return { ok: false, error: this.restoreFailure };
    this.restored.push(path);
    if (from.from === "absent") this.working.delete(path);
    else if (from.from === "copy") this.working.set(path, Buffer.from(from.content, "base64").toString());
    else {
      const content = this.committedFiles[path];
      if (content === undefined) this.working.delete(path);
      else this.working.set(path, content);
    }
    return { ok: true, value: undefined };
  }
}

/** Snapshots as stored: whatever was saved, or what a test put there instead. */
class FakeSnapshots implements ShellSnapshots {
  readonly kept = new Map<string, unknown>();
  takeFailure: string | undefined;
  async save(callId: string, snapshot: Snapshot): Promise<void> {
    this.kept.set(callId, JSON.parse(JSON.stringify(snapshot)));
  }
  async take(callId: string): Promise<unknown> {
    if (this.takeFailure !== undefined) throw new Error(this.takeFailure);
    const snapshot = this.kept.get(callId);
    this.kept.delete(callId);
    return snapshot;
  }
  saved(callId: string): Snapshot {
    return this.kept.get(callId) as Snapshot;
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

function setup(limits?: { perFile: number; total: number }) {
  const files = new FakeFiles({ "generated/a.ts": "a", "generated/README.md": "r", "bounded.config.ts": "c", "src/b.ts": "b" });
  const snapshots = new FakeSnapshots();
  const log = new FakeLog();
  return { files, snapshots, log, watch: new WatchShellHandler(composition, files, snapshots, log, clock, limits === undefined ? {} : { limits }) };
}

describe("WatchShellHandler — before a shell command", () => {
  test("hashes the watched files and keeps them under the call's id, then allows", async () => {
    const { watch, snapshots } = setup();
    expect((await watch.snapshot(use(shell))).kind).toBe("allow");
    expect(Object.keys(snapshots.saved("c1").files).sort()).toEqual(["bounded.config.ts", "generated/a.ts"]);
    expect(snapshots.saved("c1").commit).toBe(COMMIT);
  });

  test("a watched file that matches the commit is kept by reference; one that differs, or is untracked, is copied", async () => {
    const { watch, files, snapshots } = setup();
    files.working.set("generated/a.ts", "uncommitted work");
    files.working.set("generated/untracked.ts", "never committed");
    await watch.snapshot(use(shell));
    const saved = snapshots.saved("c1").files;
    expect(saved["bounded.config.ts"]).toEqual({ hash: sha("c"), size: 1, rule: 1, kept: { from: "commit" } });
    expect(saved["generated/a.ts"]).toEqual({ hash: sha("uncommitted work"), size: 16, rule: 0, kept: { from: "copy", content: base64("uncommitted work") } });
    expect(saved["generated/untracked.ts"]?.kept).toEqual({ from: "copy", content: base64("never committed") });
  });

  test("a file over the copy limits is kept by its hash alone", async () => {
    const { watch, files, snapshots } = setup({ perFile: 10, total: 20 });
    files.working.set("generated/big.ts", "far more than ten bytes");
    files.working.set("generated/one.ts", "0123456789");
    files.working.set("generated/two.ts", "abcdefghij");
    files.working.set("generated/three.ts", "ABCDEFGHIJ");
    await watch.snapshot(use(shell));
    const saved = snapshots.saved("c1").files;
    expect(saved["generated/big.ts"]?.kept).toEqual({ from: "nowhere" });
    expect(saved["generated/big.ts"]?.hash).toBe(sha("far more than ten bytes"));
    const copied = ["generated/one.ts", "generated/three.ts", "generated/two.ts"].filter((path) => saved[path]?.kept.from === "copy");
    expect(copied.length).toBe(2);
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
      "This command changed protected files, and they were restored: generated/a.ts was modified, generated/new.ts was created. generated/ is written by the generator. Change the generator's input instead. bounded.config.ts was deleted. the configuration decides what agents may do. Ask the project's owner.",
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
      "This command changed protected files, and restoring them FAILED (not a git repository); restore them by hand: generated/a.ts was modified. generated/ is written by the generator. Change the generator's input instead.",
    );
    expect(log.decisions[0]?.note).toBe("changed by a shell command; restore failed");
  });

  test("uncommitted work in a watched file is put back from the snapshot's copy, not from the commit", async () => {
    const { watch, files, log } = setup();
    files.working.set("generated/a.ts", "uncommitted edit");
    await watch.snapshot(use(shell));
    files.working.set("generated/a.ts", "tampered");
    const check = await watch.verify(result());
    expect(check.restored).toBe(true);
    expect(check.changed).toEqual([{ path: "generated/a.ts", change: "modified" }]);
    expect(files.working.get("generated/a.ts")).toBe("uncommitted edit");
    expect(check.message?.startsWith("This command changed protected files, and they were restored: generated/a.ts was modified.")).toBe(true);
    expect(log.decisions[0]?.note).toBe("changed by a shell command; restored");
  });

  test("an untracked watched file the command deleted is put back from its copy", async () => {
    const { watch, files } = setup();
    files.working.set("generated/local.ts", "mine");
    await watch.snapshot(use(shell));
    files.working.delete("generated/local.ts");
    const check = await watch.verify(result());
    expect(check.changed).toEqual([{ path: "generated/local.ts", change: "deleted" }]);
    expect(check.restored).toBe(true);
    expect(files.working.get("generated/local.ts")).toBe("mine");
  });

  test("a file too large to copy that the command changed is reported, recorded and left as the command left it, never replaced", async () => {
    const { watch, files, log } = setup({ perFile: 10, total: 100 });
    files.working.set("generated/big.ts", "far more than ten bytes");
    await watch.snapshot(use(shell));
    files.working.set("generated/big.ts", "changed by the command");
    files.working.set("generated/a.ts", "tampered");
    const check = await watch.verify(result());
    expect(check.restored).toBe(false);
    expect(check.message).toContain("restoring them FAILED (generated/big.ts was too large to keep a copy of, so it was left as the command left it)");
    expect(files.working.get("generated/big.ts")).toBe("changed by the command");
    expect(files.working.get("generated/a.ts")).toBe("a");
    expect(files.restored).not.toContain("generated/big.ts");
    expect(log.decisions[0]?.note).toBe("changed by a shell command; restore failed");
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

describe("WatchShellHandler — a snapshot that is missing or altered", () => {
  const MISSING = "The snapshot for this command was missing or altered";

  test("a deleted snapshot does not hide a protected change: it is reported against the commit, recorded, and nothing is restored", async () => {
    const { watch, files, snapshots, log } = setup();
    await watch.snapshot(use(shell));
    files.working.set("generated/a.ts", "tampered");
    snapshots.kept.clear();
    const check = await watch.verify(result());
    expect(check.restored).toBe(false);
    expect(check.changed).toEqual([{ path: "generated/a.ts", change: "modified" }]);
    expect(check.message).toContain(MISSING);
    expect(check.message).toContain("generated/a.ts was modified");
    expect(files.working.get("generated/a.ts")).toBe("tampered");
    expect(files.restored).toEqual([]);
    expect(log.decisions.map((decision) => decision.note)).toEqual(["snapshot missing or altered"]);
    expect(log.decisions[0]?.verdict.kind).toBe("refuse");
  });

  test("a snapshot that cannot be read is reported and recorded, even when nothing differs", async () => {
    const { watch, snapshots, log } = setup();
    await watch.snapshot(use(shell));
    snapshots.takeFailure = "Unexpected token g in JSON";
    const check = await watch.verify(result());
    expect(check.message).toContain(MISSING);
    expect(check.message).toContain("Unexpected token g in JSON");
    expect(log.decisions.map((decision) => decision.note)).toEqual(["snapshot missing or altered"]);
  });

  test("a snapshot whose hashes were rewritten, or do not parse, counts as altered", async () => {
    for (const forged of [sha("tampered"), "not a hash"]) {
      const { watch, files, snapshots, log } = setup();
      await watch.snapshot(use(shell));
      const saved = snapshots.kept.get("c1") as { files: Record<string, { hash: string }> };
      (saved.files["generated/a.ts"] as { hash: string }).hash = forged;
      files.working.set("generated/a.ts", "tampered");
      const check = await watch.verify(result());
      expect(check.message).toContain(MISSING);
      expect(check.changed).toEqual([{ path: "generated/a.ts", change: "modified" }]);
      expect(log.decisions.length).toBe(1);
    }
  });

  test("a copy whose hash does not match its content counts as altered", async () => {
    const { watch, files, snapshots } = setup();
    files.working.set("generated/a.ts", "uncommitted");
    await watch.snapshot(use(shell));
    const saved = snapshots.kept.get("c1") as { files: Record<string, { hash: string }> };
    (saved.files["generated/a.ts"] as { hash: string }).hash = sha("tampered");
    files.working.set("generated/a.ts", "tampered");
    expect((await watch.verify(result())).message).toContain(MISSING);
    expect(files.working.get("generated/a.ts")).toBe("tampered");
  });

  test("a snapshot that is not a snapshot at all counts as altered", async () => {
    const { watch, snapshots } = setup();
    snapshots.kept.set("c1", { garbled: true });
    expect((await watch.verify(result())).message).toContain(MISSING);
  });

  test("a failure while checking is still recorded", async () => {
    const { watch, files, log } = setup();
    await watch.snapshot(use(shell));
    files.gitThrows = "git vanished";
    const check = await watch.verify(result());
    expect(check.restored).toBe(false);
    expect(check.message).toContain("git vanished");
    expect(log.decisions.length).toBe(1);
  });

  test("a result without a shell command is never checked, snapshot or not", async () => {
    const { watch, files, log } = setup();
    files.working.set("generated/a.ts", "tampered");
    const edit = ToolResult.parse({ kind: "tool-result", role: null, tool: "edit", effects: [{ kind: "write", path: "src/b.ts", change: "modify" }], ok: true, callId: "e1" });
    if (!edit.ok) throw new Error(edit.error);
    expect(await watch.verify(edit.value)).toEqual({ changed: [], restored: true, message: null });
    expect(log.decisions).toEqual([]);
  });
});
