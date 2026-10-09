import { describe, expect, test } from "bun:test";
import { Composition, contribution, corePack, Decision, DecisionId, definePack, point, type Result, ToolResult, ToolUse } from "bounded/domain";
import { protectedPathsId } from "../../domain/protected-paths-id.ts";
import type { ProtectedPathJSON } from "../../domain/protected-path.contract.ts";
import { ProtectedPath } from "../../domain/protected-path.ts";
import type { WatchedChange, WatchedPath } from "../../domain/watched-path.contract.ts";
import type { RestoreFrom, ShellSnapshots, Snapshot, WatchedFile, WatchedFiles, WatchedHashes, WatchShell } from "./watch-shell.contract.ts";
import { WatchShellHandler } from "./watch-shell.handler.ts";

const clock = { now: () => "2026-10-08T12:00:00.000Z" };
const RULES_REDIRECT = "Change the generator's input instead";

const sha = (content: string): string => new Bun.CryptoHasher("sha256").update(content).digest("hex");
const base64 = (content: string): string => Buffer.from(content).toString("base64");
const COMMIT = "c0";
const QUARANTINE = "/state/bounded/project/quarantine/1";

/** Files in memory: `committed` is version control at commit c0, `working` the files now. */
class FakeFiles implements WatchedFiles {
  readonly working: Map<string, string>;
  hashFailure: string | undefined;
  restoreFailure: string | undefined;
  gitThrows: string | undefined;
  restored: string[] = [];
  /** Files moved aside, by path, and the paths that are links. */
  readonly quarantined = new Map<string, string>();
  readonly links = new Set<string>();
  /** Whether hashes name every watched path that matches a file, as the adapters do. */
  allRules = false;
  constructor(private readonly committedFiles: Record<string, string>) {
    this.working = new Map(Object.entries(committedFiles));
  }

  private hashes(files: Iterable<[string, string]>, rules: readonly WatchedPath[]): WatchedHashes {
    const out: Record<string, WatchedFile> = {};
    for (const [path, content] of files) {
      const rule = rules.findIndex((r) => new Bun.Glob(r.match).match(path) && !(r.except ?? []).some((e) => new Bun.Glob(e).match(path)));
      const every = this.allRules ? rules.flatMap((r, index) => (new Bun.Glob(r.match).match(path) && !(r.except ?? []).some((e) => new Bun.Glob(e).match(path)) ? [index] : [])) : [];
      if (rule >= 0) out[path] = { hash: sha(content), size: content.length, rule, ...(every.length > 1 ? { rules: every } : {}), ...(this.links.has(path) ? { link: true as const } : {}) };
    }
    return out;
  }

  rulesWatching(rules: readonly WatchedPath[], path: string): readonly number[] {
    const every = rules.flatMap((r, index) => (new Bun.Glob(r.match).match(path) && !(r.except ?? []).some((e) => new Bun.Glob(e).match(path)) ? [index] : []));
    return this.allRules ? every : every.slice(0, 1);
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

  async copy(path: string): Promise<Result<{ hash: string; size: number; content: string; executable: boolean }>> {
    if (this.links.has(path)) return { ok: false, error: `${path} is a link` };
    const content = this.working.get(path);
    if (content === undefined) return { ok: false, error: `${path} does not exist` };
    return { ok: true, value: { hash: sha(content), size: content.length, content: base64(content), executable: false } };
  }

  async restore(path: string, from: RestoreFrom): Promise<Result<void>> {
    if (this.restoreFailure !== undefined) return { ok: false, error: this.restoreFailure };
    this.restored.push(path);
    if (from.from === "copy") this.working.set(path, Buffer.from(from.content, "base64").toString());
    else {
      const content = this.committedFiles[path];
      if (content === undefined) this.working.delete(path);
      else this.working.set(path, content);
    }
    return { ok: true, value: undefined };
  }

  async quarantine(paths: readonly string[]): Promise<Result<string>> {
    if (this.restoreFailure !== undefined) return { ok: false, error: this.restoreFailure };
    for (const path of paths) {
      this.quarantined.set(path, this.working.get(path) ?? "");
      this.working.delete(path);
    }
    return { ok: true, value: QUARANTINE };
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

/** What the core records of each report the handler returns, as the Bounded log would hold it. */
class FakeLog {
  readonly decisions: Decision[] = [];
}

/**
 * A stand-in for the protected-paths pack: a pack with its id whose protected paths are
 * only what a test contributes (none of the protected-paths pack's own rules), so each
 * test watches exactly the paths it names.
 */
const protectedPathsStandIn = definePack({ id: protectedPathsId, points: { protectedPaths: point({ description: "Protected paths", check: ProtectedPath.parse }) } });
const protectedPaths = protectedPathsStandIn.points.protectedPaths;

/** A watched path as a test names it: what it matches, the changes it forbids (every one unless said), why, and what to do instead. */
interface Watching {
  readonly match: string;
  readonly except?: readonly string[];
  readonly changes?: readonly WatchedChange[];
  readonly why: string;
  readonly redirect: string;
}
/** The protected path that watches exactly that: a literal name is a file rule, so it is watched alone. */
const ruleFor = ({ changes, ...watched }: Watching): ProtectedPathJSON => ({ ...watched, deny: changes === undefined || changes.length === 0 ? ["create", "modify", "delete"] : [changes[0] as WatchedChange, ...changes.slice(1)], ...(/[*?[\]{}]/.test(watched.match.split("/").at(-1) ?? "") ? {} : { file: true }) });

/** A composition whose protected paths are exactly `watched`, in order. */
function watching(local: string, watched: readonly Watching[]): Composition {
  const rules = (definePack as unknown as (spec: object) => typeof protectedPathsStandIn)({ id: `test-packs/${local}`, dependsOn: [protectedPathsStandIn], contributes: [contribution(protectedPaths, watched.map(ruleFor))] });
  const composed = Composition.compose([protectedPathsStandIn, rules, corePack], [protectedPathsStandIn, rules, corePack]);
  if (!composed.ok) throw new Error(composed.error);
  return composed.value;
}

/** The handler, recording each report's record as the core would, naming the protected-paths pack. */
function recorded(handler: WatchShellHandler, log: FakeLog): WatchShell {
  return {
    snapshot: (call) => handler.snapshot(call),
    verify: async (given) => {
      const report = await handler.verify(given);
      if (report.record !== null) {
        const { verdict, refusedBy, note } = report.record;
        const id = DecisionId.parse(`d-${log.decisions.length + 1}`);
        if (!id.ok) throw new Error(id.error);
        log.decisions.push(Decision.of(id.value, clock.now(), given, { verdict, refusedBy: refusedBy === null ? null : { packId: protectedPathsId, effect: refusedBy.effect } }, note));
      }
      return report;
    },
  };
}

const rules = watching("rules", [
      { match: "generated/**", except: ["generated/README.md"], why: "generated/ is written by the generator", redirect: RULES_REDIRECT },
      { match: "bounded.config.ts", why: "the configuration decides what agents may do", redirect: "Ask the project's owner" },
]);
const composition = rules;

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
  return { files, snapshots, log, watch: recorded(new WatchShellHandler(composition, protectedPaths, files, snapshots, limits === undefined ? {} : { limits }), log) };
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
    expect(saved["generated/a.ts"]).toEqual({ hash: sha("uncommitted work"), size: 16, rule: 0, kept: { from: "copy", content: base64("uncommitted work"), executable: false } });
    expect(saved["generated/untracked.ts"]?.kept).toEqual({ from: "copy", content: base64("never committed"), executable: false });
  });

  test("a link a rule watches is kept by its hash alone: it is never copied", async () => {
    const { watch, files, snapshots } = setup();
    files.working.set("generated/link.ts", "-> ../elsewhere");
    files.links.add("generated/link.ts");
    expect((await watch.snapshot(use(shell))).kind).toBe("allow");
    expect(snapshots.saved("c1").files["generated/link.ts"]?.kept).toEqual({ from: "nowhere" });
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
    expect(await watch.verify(result())).toEqual({ changed: [], restored: true, message: null, record: null });
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
      `This command changed protected files, and they were restored: generated/a.ts was modified, generated/new.ts was created — protected because generated/ is written by the generator. Change the generator's input instead. bounded.config.ts was deleted — protected because the configuration decides what agents may do. Ask the project's owner. What it created was moved, not deleted, to ${QUARANTINE}.`,
    );
    expect(files.quarantined.get("generated/new.ts")).toBe("created");
    expect(files.working.get("generated/a.ts")).toBe("a");
    expect(files.working.get("bounded.config.ts")).toBe("c");
    expect(files.working.has("generated/new.ts")).toBe(false);
    expect(files.working.get("generated/README.md")).toBe("not watched");
    expect(log.decisions.length).toBe(1);
    expect(log.decisions[0]?.event).toBe("tool-result");
    expect(log.decisions[0]?.note).toBe("changed by a shell command; restored");
    expect<unknown>(log.decisions[0]?.verdict).toEqual({ kind: "refuse", reason: check.message, redirect: RULES_REDIRECT, pack: "bounded/protected-paths", effect: "execute `make`" });
  });

  test("a restore that fails is reported loudly and recorded", async () => {
    const { watch, files, log } = setup();
    await watch.snapshot(use(shell));
    files.working.set("generated/a.ts", "tampered");
    files.restoreFailure = "not a git repository";
    const check = await watch.verify(result());
    expect(check.restored).toBe(false);
    expect(check.message).toBe(
      "This command changed protected files, and restoring them FAILED (not a git repository); restore them by hand: generated/a.ts was modified — protected because generated/ is written by the generator. Change the generator's input instead.",
    );
    expect(log.decisions[0]?.note).toBe("changed by a shell command; restore failed");
  });

  test("a file whose snapshot entry was removed is moved aside, never deleted", async () => {
    const { watch, files, snapshots, log } = setup();
    await watch.snapshot(use(shell));
    const saved = snapshots.kept.get("c1") as { files: Record<string, unknown> };
    delete saved.files["bounded.config.ts"];
    const check = await watch.verify(result());
    expect(check.changed).toEqual([{ path: "bounded.config.ts", change: "created" }]);
    expect(files.working.has("bounded.config.ts")).toBe(false);
    expect(files.quarantined.get("bounded.config.ts")).toBe("c");
    expect(check.message).toContain(QUARANTINE);
    expect(log.decisions[0]?.verdict.kind === "refuse" && log.decisions[0].verdict.reason).toContain(QUARANTINE);
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
    expect(check.message?.startsWith("This command changed protected files, and they were restored: generated/a.ts was modified — protected because")).toBe(true);
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
    expect(await watch.verify(result())).toMatchObject({
      changed: [],
      restored: false,
      message: "Protected files could not be checked after this command: disk gone. Check them by hand against version control.",
    });
    expect(log.decisions[0]?.note).toBe("could not be checked after a shell command");
  });

  test("a result with no snapshot (no shell command, or no call id) has nothing to check", async () => {
    const { watch } = setup();
    expect(await watch.verify(result({ callId: "never-seen" }))).toEqual({ changed: [], restored: true, message: null, record: null });
    const { callId: _id, ...anonymous } = { ...shell, kind: "tool-result", ok: true };
    const parsed = ToolResult.parse(anonymous);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(await watch.verify(parsed.value)).toEqual({ changed: [], restored: true, message: null, record: null });
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
    expect(await watch.verify(edit.value)).toEqual({ changed: [], restored: true, message: null, record: null });
    expect(log.decisions).toEqual([]);
  });
});

describe("WatchShellHandler — only the changes a watched path forbids are undone", () => {
  const migrations = watching("migrations", [
        { match: "migrations/**", changes: ["modify", "delete"], why: "applied migrations are history", redirect: "Add a new migration instead" },
        { match: "generated/**", why: "generated/ is written by the generator", redirect: RULES_REDIRECT },
  ]);
  function migrationsSetup() {
    const composed = { value: migrations };
    const files = new FakeFiles({ "migrations/0001_init.sql": "create table a;", "generated/a.ts": "a" });
    const log = new FakeLog();
    return { files, log, watch: recorded(new WatchShellHandler(composed.value, protectedPaths, files, new FakeSnapshots()), log) };
  }

  test("a file created where only modify and delete are forbidden is left in place, with nothing to say and nothing recorded", async () => {
    const { watch, files, log } = migrationsSetup();
    await watch.snapshot(use(shell));
    files.working.set("migrations/0002_add.sql", "create table b;");
    expect(await watch.verify(result())).toEqual({ changed: [], restored: true, message: null, record: null });
    expect(files.working.get("migrations/0002_add.sql")).toBe("create table b;");
    expect(files.quarantined.size).toBe(0);
    expect(log.decisions).toEqual([]);
  });

  test("a forbidden modify or delete is still put back and reported, an allowed create beside it left alone", async () => {
    const { watch, files, log } = migrationsSetup();
    await watch.snapshot(use(shell));
    files.working.set("migrations/0001_init.sql", "drop table a;");
    files.working.set("migrations/0002_add.sql", "create table b;");
    const modified = await watch.verify(result());
    expect(modified.changed).toEqual([{ path: "migrations/0001_init.sql", change: "modified" }]);
    expect(files.working.get("migrations/0001_init.sql")).toBe("create table a;");
    expect(files.working.get("migrations/0002_add.sql")).toBe("create table b;");
    expect(modified.message).toBe("This command changed protected files, and they were restored: migrations/0001_init.sql was modified — protected because applied migrations are history. Add a new migration instead.");
    await watch.snapshot(use({ ...shell, callId: "c2" }));
    files.working.delete("migrations/0001_init.sql");
    const deleted = await watch.verify(result({ callId: "c2" }));
    expect(deleted.changed).toEqual([{ path: "migrations/0001_init.sql", change: "deleted" }]);
    expect(files.working.get("migrations/0001_init.sql")).toBe("create table a;");
    expect(log.decisions.length).toBe(2);
  });

  test("a path that forbids every change still moves what a command created aside", async () => {
    const { watch, files } = migrationsSetup();
    await watch.snapshot(use(shell));
    files.working.set("generated/new.ts", "created");
    const check = await watch.verify(result());
    expect(check.changed).toEqual([{ path: "generated/new.ts", change: "created" }]);
    expect(files.quarantined.get("generated/new.ts")).toBe("created");
  });

  test("with no snapshot to trust, only forbidden changes are reported against the commit", async () => {
    const { watch, files } = migrationsSetup();
    files.working.set("migrations/0002_add.sql", "create table b;");
    expect(await watch.verify(result({ callId: "never-seen" }))).toEqual({ changed: [], restored: true, message: null, record: null });
    files.working.set("migrations/0001_init.sql", "drop table a;");
    const check = await watch.verify(result({ callId: "never-seen" }));
    expect(check.changed).toEqual([{ path: "migrations/0001_init.sql", change: "modified" }]);
  });
});

describe("WatchShellHandler — every watched path that matches a file counts", () => {
  test("a looser path never shadows a stricter one: a change any of them forbids is undone, reported by the first that forbids it", async () => {
    const layered = watching("layered", [
          { match: "generated/**", changes: ["create"], why: "nothing new goes into generated/", redirect: "Change the generator's input" },
          { match: "generated/a.ts", changes: ["modify", "delete"], why: "a.ts is pinned", redirect: "Ask the owner of a.ts" },
    ]);
    const composed = { value: layered };
    const files = new FakeFiles({ "generated/a.ts": "a", "generated/b.ts": "b" });
    files.allRules = true;
    const log = new FakeLog();
    const watch = recorded(new WatchShellHandler(composed.value, protectedPaths, files, new FakeSnapshots()), log);
    await watch.snapshot(use(shell));
    files.working.set("generated/a.ts", "tampered");
    files.working.set("generated/b.ts", "changed, which is allowed");
    const check = await watch.verify(result());
    expect(check.changed).toEqual([{ path: "generated/a.ts", change: "modified" }]);
    expect(files.working.get("generated/a.ts")).toBe("a");
    expect(files.working.get("generated/b.ts")).toBe("changed, which is allowed");
    expect(check.message).toBe("This command changed protected files, and they were restored: generated/a.ts was modified — protected because a.ts is pinned. Ask the owner of a.ts.");
    expect(log.decisions[0]?.verdict).toMatchObject({ redirect: "Ask the owner of a.ts" });
  });
});

describe("WatchShellHandler — which paths watch a file is worked out again after the command", () => {
  test("a snapshot whose stored rules were loosened still has every forbidden change undone", async () => {
    const layered = watching("layered", [
          { match: "generated/**", changes: ["create"], why: "nothing new goes into generated/", redirect: "Change the generator's input" },
          { match: "generated/a.ts", changes: ["modify", "delete"], why: "a.ts is pinned", redirect: "Ask the owner of a.ts" },
    ]);
    const composed = { value: layered };
    const files = new FakeFiles({ "generated/a.ts": "a" });
    files.allRules = true;
    const snapshots = new FakeSnapshots();
    const watch = recorded(new WatchShellHandler(composed.value, protectedPaths, files, snapshots), new FakeLog());
    await watch.snapshot(use(shell));
    const saved = snapshots.kept.get("c1") as { files: Record<string, { rule: number; rules?: number[] }> };
    const entry = saved.files["generated/a.ts"] as { rule: number; rules?: number[] };
    entry.rule = 0;
    delete entry.rules;
    files.working.set("generated/a.ts", "tampered");
    const check = await watch.verify(result());
    expect(check.changed).toEqual([{ path: "generated/a.ts", change: "modified" }]);
    expect(files.working.get("generated/a.ts")).toBe("a");
  });
});
