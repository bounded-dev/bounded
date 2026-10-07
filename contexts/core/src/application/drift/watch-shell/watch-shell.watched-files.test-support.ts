import { describe, expect, test } from "bun:test";
import { WatchedPath } from "bounded/domain";
import type { WatchedFiles } from "./watch-shell.contract.ts";

/** A project whose version control holds `committed`; the files port over it, and the means to change its working files. */
export interface WatchedFilesFixture {
  readonly files: WatchedFiles;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  read(path: string): Promise<string | undefined>;
}

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

    test("restores modified and deleted files from version control and removes files it never held", async () => {
      const { files, write, remove, read } = await fixture(committed);
      await write("generated/a.ts", "changed");
      await remove("generated/keep.md");
      await write("generated/new.ts", "created");
      expect(await files.restore(["generated/a.ts", "generated/keep.md", "generated/new.ts"])).toEqual({ ok: true, value: undefined });
      expect(await read("generated/a.ts")).toBe("a");
      expect(await read("generated/keep.md")).toBe("k");
      expect(await read("generated/new.ts")).toBeUndefined();
    });

    test("with no rules, hashes nothing", async () => {
      const { files } = await fixture(committed);
      expect(await files.hash([])).toEqual({ ok: true, value: {} });
    });
  });
}
