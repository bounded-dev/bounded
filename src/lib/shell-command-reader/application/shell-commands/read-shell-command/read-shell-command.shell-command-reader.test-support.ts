import { describe, expect, test } from "bun:test";
import { Command, ProjectPath, ShellCommandReading } from "bounded/domain";
import type { ShellCommandReader } from "./read-shell-command.contract.ts";

// The conformance suite every ShellCommandReader runs (published as
// bounded/testing/shell-command-reader-conformance, ADR 2026-020). It names
// only made-up programs, so it asks nothing of a reader's knowledge of real
// ones: what the shell itself says (words, redirections, cd) is read, and
// what only the shell can resolve is reported unresolved, never guessed.

/** A project for a reader to read commands in: the files and directories it holds. */
export interface ShellCommandReaderLayout {
  readonly files: readonly string[];
  readonly dirs: readonly string[];
}

/** A reader, fresh and not yet prepared, over a project holding `layout`, and that project's root. */
export type ShellCommandReaderFixture = (layout: ShellCommandReaderLayout) => Promise<{ readonly reader: ShellCommandReader; readonly projectRoot: string }>;

const made = <T>(parsed: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

/** What `reader` makes of `command`, run from `cwd`, parsed as ReadShellCommand parses it; a reading that was not read fails the test with its why. */
async function readingOf(reader: ShellCommandReader, projectRoot: string, command: string, cwd: string | null = null) {
  const reading = made(ShellCommandReading.parse(await reader.read(projectRoot, made(Command.parse(command)), cwd === null ? null : made(ProjectPath.parse(cwd)))));
  if (reading.outcome !== "read") throw new Error(`the command was not read: ${reading.why}`);
  return reading.toJSON();
}

const literal = (text: string) => ({ kind: "literal" as const, text });

/** The behaviour every ShellCommandReader must have. */
export function shellCommandReaderConformance(name: string, fixture: ShellCommandReaderFixture): void {
  describe(`${name} conforms to ShellCommandReader`, () => {
    test("reads the programs a command runs, each with its literal arguments, from the project root", async () => {
      const { reader, projectRoot } = await fixture({ files: [], dirs: [] });
      const reading = await readingOf(reader, projectRoot, "tool-a 'one two' three; tool-b");
      expect(reading.programs).toEqual([
        { name: literal("tool-a"), arguments: [literal("one two"), literal("three")], workingDirectory: "." },
        { name: literal("tool-b"), arguments: [], workingDirectory: "." },
      ]);
    });

    test("a redirect to a missing file is a create, to an existing one a modify", async () => {
      const { reader, projectRoot } = await fixture({ files: ["log.txt"], dirs: [] });
      const reading = await readingOf(reader, projectRoot, "tool-a > out.txt; tool-a >> log.txt");
      expect(reading.fileEffects).toContainEqual({ effect: { kind: "write", path: "out.txt", change: "create" } });
      expect(reading.fileEffects).toContainEqual({ effect: { kind: "write", path: "log.txt", change: "modify" } });
      expect(reading.fileEffects).not.toContainEqual({ effect: { kind: "write", path: "log.txt", change: "create" } });
    });

    test("a cd takes later programs and paths with it", async () => {
      const { reader, projectRoot } = await fixture({ files: [], dirs: ["sub"] });
      const reading = await readingOf(reader, projectRoot, "cd sub && tool-a > out.txt", null);
      expect(reading.programs.at(-1)).toEqual({ name: literal("tool-a"), arguments: [], workingDirectory: "sub" });
      expect(reading.fileEffects).toContainEqual({ effect: { kind: "write", path: "sub/out.txt", change: "create" } });
      const from = await readingOf(reader, projectRoot, "tool-a", "sub");
      expect(from.programs).toEqual([{ name: literal("tool-a"), arguments: [], workingDirectory: "sub" }]);
    });

    test("what only the shell can resolve is unresolved, never guessed", async () => {
      const { reader, projectRoot } = await fixture({ files: [], dirs: [] });
      const reading = await readingOf(reader, projectRoot, "$TOOL x; tool-a $X > $Y");
      expect(reading.programs).toEqual([
        { name: { kind: "unresolved", text: "$TOOL" }, arguments: [literal("x")], workingDirectory: "." },
        { name: literal("tool-a"), arguments: [{ kind: "unresolved", text: "$X" }], workingDirectory: "." },
      ]);
      expect(reading.unresolved).toContainEqual({ text: "$Y", role: "write" });
      expect(reading.fileEffects.filter(({ effect }) => effect.kind === "write")).toEqual([]);
      const nowhere = await readingOf(reader, projectRoot, "cd $DIR && tool-a");
      expect(nowhere.programs.at(-1)?.workingDirectory).toBeNull();
      expect(nowhere.unresolved).toContainEqual({ text: "$DIR", role: "directory" });
    });

    test("reads without being prepared, and preparing twice is harmless", async () => {
      const fresh = await fixture({ files: [], dirs: [] });
      expect((await readingOf(fresh.reader, fresh.projectRoot, "tool-a")).programs).toHaveLength(1);
      const prepared = await fixture({ files: [], dirs: [] });
      await prepared.reader.prepare();
      await prepared.reader.prepare();
      expect((await readingOf(prepared.reader, prepared.projectRoot, "tool-a")).programs).toHaveLength(1);
    });
  });
}
