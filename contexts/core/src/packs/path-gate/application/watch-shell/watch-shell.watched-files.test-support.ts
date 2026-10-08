import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { WatchedPath } from "../../domain/watched-path.ts";
import type { WatchedFiles } from "./watch-shell.contract.ts";

/** A project whose version control holds `committed`; the files port over it, and the means to change its working files. */
export interface WatchedFilesFixture {
  readonly files: WatchedFiles;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  read(path: string): Promise<string | undefined>;
  /** What a file moved aside to `location` holds now. */
  readQuarantined(location: string, path: string): Promise<string | undefined>;
}

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

function rule(match: string, except: string[] = []): WatchedPath {
  const parsed = WatchedPath.parse({ match, except, why: "watched", redirect: "ask" });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** The behaviour every WatchedFiles must have. */
export function watchedFilesConformance(name: string, fixture: (committed: Readonly<Record<string, string>>) => Promise<WatchedFilesFixture>): void {
  describe(`${name} conforms to WatchedFiles`, () => {
    const committed = { "generated/a.ts": "a", "generated/keep.md": "k", "src/b.ts": "b" };

    test("hashes exactly the files a rule matches and does not except, naming the first rule each matches", async () => {
      const { files } = await fixture(committed);
      const hashed = await files.hash([rule("src/**"), rule("generated/**", ["generated/keep.md"])]);
      if (!hashed.ok) throw new Error(hashed.error);
      expect(Object.keys(hashed.value).sort()).toEqual(["generated/a.ts", "src/b.ts"]);
      expect(hashed.value["src/b.ts"]?.rule).toBe(0);
      expect(hashed.value["generated/a.ts"]?.rule).toBe(1);
    });

    test("a file's hash changes when its content does, and only then", async () => {
      const { files, write } = await fixture(committed);
      const before = await files.hash([rule("generated/**")]);
      const again = await files.hash([rule("generated/**")]);
      await write("generated/a.ts", "changed");
      const after = await files.hash([rule("generated/**")]);
      if (!before.ok || !again.ok || !after.ok) throw new Error("expected hashes");
      expect(again.value["generated/a.ts"]?.hash).toBe(before.value["generated/a.ts"]?.hash ?? "missing");
      expect(after.value["generated/a.ts"]?.hash).not.toBe(before.value["generated/a.ts"]?.hash ?? "missing");
    });

    test("restores modified and deleted files from version control, and moves files it never held aside", async () => {
      const { files, write, remove, read, readQuarantined } = await fixture(committed);
      const head = await files.head();
      if (!head.ok || head.value === null) throw new Error("expected a commit");
      const commit = { from: "commit", commit: head.value } as const;
      await write("generated/a.ts", "changed");
      await remove("generated/keep.md");
      await write("generated/new.ts", "created");
      for (const path of ["generated/a.ts", "generated/keep.md"]) expect(await files.restore(path, commit)).toEqual({ ok: true, value: undefined });
      const moved = await files.quarantine(["generated/new.ts"]);
      if (!moved.ok) throw new Error(moved.error);
      expect(await read("generated/a.ts")).toBe("a");
      expect(await read("generated/keep.md")).toBe("k");
      expect(await read("generated/new.ts")).toBeUndefined();
      expect(await readQuarantined(moved.value, "generated/new.ts")).toBe("created");
      const again = await files.quarantine(["generated/a.ts"]);
      expect(again.ok && again.value !== moved.value).toBe(true);
    });

    test("a hash is the SHA-256 of the file's bytes, given with its size", async () => {
      const { files } = await fixture(committed);
      const hashed = await files.hash([rule("src/**")]);
      expect(hashed).toEqual({ ok: true, value: { "src/b.ts": { hash: sha256("b"), size: 1, rule: 0 } } });
    });

    test("head names the commit, and committed gives the watched files as it holds them, whatever the files are now", async () => {
      const { files, write, remove } = await fixture(committed);
      await write("generated/a.ts", "changed");
      await remove("src/b.ts");
      await write("generated/new.ts", "created");
      const head = await files.head();
      if (!head.ok || head.value === null) throw new Error("expected a commit");
      expect(await files.committed([rule("src/**"), rule("generated/**", ["generated/keep.md"])], head.value)).toEqual({
        ok: true,
        value: { "src/b.ts": { hash: sha256("b"), size: 1, rule: 0 }, "generated/a.ts": { hash: sha256("a"), size: 1, rule: 1 } },
      });
    });

    test("copies a file's bytes, and restores them exactly from the copy", async () => {
      const { files, write, read } = await fixture(committed);
      await write("generated/a.ts", "uncommitted ✓");
      const copied = await files.copy("generated/a.ts");
      if (!copied.ok) throw new Error(copied.error);
      expect(copied.value.hash).toBe(sha256("uncommitted ✓"));
      expect(copied.value.size).toBe(Buffer.byteLength("uncommitted ✓"));
      expect(copied.value.executable).toBe(false);
      await write("generated/a.ts", "tampered");
      expect(await files.restore("generated/a.ts", { from: "copy", content: copied.value.content, executable: false })).toEqual({ ok: true, value: undefined });
      expect(await read("generated/a.ts")).toBe("uncommitted ✓");
      expect((await files.copy("generated/missing.ts")).ok).toBe(false);
    });

    test("says which rules watch a path, whether or not a file is there", async () => {
      const { files } = await fixture(committed);
      const rules = [rule("src/**"), rule("generated/**"), rule("generated/a.ts"), rule("**/*.ts", ["src/**"])];
      expect(files.rulesWatching(rules, "generated/a.ts")).toEqual([1, 2, 3]);
      expect(files.rulesWatching(rules, "generated/gone.ts")).toEqual([1, 3]);
      expect(files.rulesWatching(rules, "docs/x.md")).toEqual([]);
    });

    test("names every rule that watches a file, the first as its rule, when more than one does", async () => {
      const { files } = await fixture(committed);
      const hashed = await files.hash([rule("src/**"), rule("generated/**"), rule("generated/a.ts"), rule("**/*.ts", ["src/**"])]);
      if (!hashed.ok) throw new Error(hashed.error);
      expect(hashed.value["generated/a.ts"]).toMatchObject({ rule: 1, rules: [1, 2, 3] });
      expect(hashed.value["src/b.ts"]?.rule).toBe(0);
      expect(hashed.value["src/b.ts"]?.rules).toBeUndefined();
    });

    test("a rule's match ignores case, as the path gate's does; its except does not", async () => {
      const { files, write } = await fixture(committed);
      await write("Docs/Guide.md", "g");
      await write("Docs/keep.md", "k");
      const hashed = await files.hash([rule("docs/**", ["docs/keep.md"])]);
      if (!hashed.ok) throw new Error(hashed.error);
      expect(Object.keys(hashed.value).sort()).toEqual(["Docs/Guide.md", "Docs/keep.md"]);
    });

    test("restores only paths inside the project", async () => {
      const { files } = await fixture(committed);
      const nothing = { from: "copy", content: "", executable: false } as const;
      expect((await files.restore("../outside.ts", nothing)).ok).toBe(false);
      expect((await files.restore("/etc/passwd", nothing)).ok).toBe(false);
      expect((await files.quarantine(["../outside.ts"])).ok).toBe(false);
    });

    test("with no rules, hashes nothing", async () => {
      const { files } = await fixture(committed);
      expect(await files.hash([])).toEqual({ ok: true, value: {} });
    });
  });
}
