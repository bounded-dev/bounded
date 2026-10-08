import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, ProjectPath, ShellCommandReading } from "bounded/domain";
import { shellCommandReaderConformance } from "bounded/testing/shell-command-reader-conformance";
import { TreeSitterShellCommandReader } from "./shell-command-reader.ts";

shellCommandReaderConformance("TreeSitterShellCommandReader", async ({ files, dirs }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "shell-command-reader-conformance-"));
  for (const dir of dirs) mkdirSync(join(projectRoot, dir), { recursive: true });
  for (const file of files) writeFileSync(join(projectRoot, file), "x");
  return { reader: new TreeSitterShellCommandReader(), projectRoot };
});

const ROOT = "/work/project";
const made = <T>(parsed: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

/** What a reader over a project where only the root is known to exist (or, given `unknown`, where nothing can be told) makes of `command`. */
async function read(command: string, options: { readonly cwd?: string; readonly unknown?: true } = {}) {
  const reader = new TreeSitterShellCommandReader({ pathKindOf: (_root, path) => (options.unknown === true ? undefined : path.value === "." ? "directory" : "absent") });
  const answer = await reader.read(ROOT, made(Command.parse(command)), options.cwd === undefined ? null : made(ProjectPath.parse(options.cwd)));
  const reading = made(ShellCommandReading.parse(answer));
  if (reading.outcome !== "read") throw new Error(`not read: ${reading.why}`);
  return reading.toJSON();
}
const names = async (command: string) => (await read(command)).programs.map((program) => program.name.text);

describe("TreeSitterShellCommandReader — bounded's reading of a shell command", () => {
  test("the reading lists every program it runs, nested and wrapped ones included, and none of its own stand-ins", async () => {
    expect(await names("sudo -u root bash -c 'cat a.txt' && echo $(date)")).toEqual(["sudo", "bash", "cat", "date", "echo"]);
    expect(await names("for f in a b; do echo $f; done")).toEqual(["echo"]);
    expect(await names("X=1")).toEqual([]);
    expect(await names("find . -name x -exec tool-a {} \\; | xargs tool-b")).toEqual(["find", "tool-a", "xargs", "tool-b"]);
  });

  test("a program whose name only the shell can resolve is listed with an unresolved name", async () => {
    expect((await read("$TOOL x")).programs).toEqual([{ name: { kind: "unresolved", text: "$TOOL" }, arguments: [{ kind: "literal", text: "x" }], workingDirectory: "." }]);
  });

  test("inline code for another language is unresolved code; what the command reads is unchanged", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["python3 -c 'print(1)' data.csv", "print(1)"],
      ["python -c 'print(1)' data.csv", "print(1)"],
      ["node -e 'run()' data.csv", "run()"],
      ["node --eval='run()' data.csv", "run()"],
      ["node -p 'run()' data.csv", "run()"],
      ["perl -E 'say 1' data.csv", "say 1"],
      ["ruby -e 'puts 1' data.csv", "puts 1"],
      ["awk '{print $1}' data.csv", "{print $1}"],
      ["gawk -F, '{print $1}' data.csv", "{print $1}"],
      ["eval 'cat data.csv'", "cat data.csv"],
      ["env -S 'tool-a' data.csv", "data.csv"],
    ];
    for (const [command, code] of cases) {
      const reading = await read(command);
      expect({ command, unresolved: reading.unresolved }).toEqual({ command, unresolved: expect.arrayContaining([{ text: code, role: "code" }]) });
    }
    expect((await read("python3 -c 'print(1)' data.csv")).fileEffects).toContainEqual({ effect: { kind: "read", path: "data.csv" } });
    expect((await read("awk -f prog.awk data.csv")).unresolved).toEqual([]);
    expect((await read("awk -f prog.awk data.csv")).fileEffects).toEqual([{ effect: { kind: "read", path: "prog.awk" } }, { effect: { kind: "read", path: "data.csv" } }]);
  });

  test("xargs's command gets an unresolved argument for its input", async () => {
    const reading = await read("xargs tool-a -v");
    expect(reading.programs.at(-1)).toEqual({ name: { kind: "literal", text: "tool-a" }, arguments: [{ kind: "literal", text: "-v" }, { kind: "unresolved", text: "(input)" }], workingDirectory: "." });
  });

  test("a write whose existence cannot be told is both a create and a modify, marked", async () => {
    expect((await read("echo x > out.txt", { unknown: true })).fileEffects).toEqual([
      { effect: { kind: "write", path: "out.txt", change: "create" }, existenceUnknown: true },
      { effect: { kind: "write", path: "out.txt", change: "modify" }, existenceUnknown: true },
    ]);
    expect((await read("echo x > out.txt")).fileEffects).toEqual([{ effect: { kind: "write", path: "out.txt", change: "create" } }]);
  });

  test("a program's working directory is null where it cannot be known", async () => {
    const reading = await read("cd $DIR && tool-a; tool-b", { cwd: "app" });
    expect(reading.programs.map((program) => [program.name.text, program.workingDirectory])).toEqual([
      ["cd", "app"],
      ["tool-a", null],
      ["tool-b", null],
    ]);
    expect((await read("(cd $DIR); tool-a")).programs.at(-1)?.workingDirectory).toBe(".");
  });

  test("a grammar that cannot load rejects the read, saying why", async () => {
    const reader = new TreeSitterShellCommandReader({ loadGrammar: async () => Promise.reject(new Error("main.wasm is missing")) });
    await expect(reader.read(ROOT, made(Command.parse("ls")), null)).rejects.toThrow("bounded's shell parser could not load (main.wasm is missing)");
    await expect(reader.prepare()).rejects.toThrow("bounded's shell parser could not load (main.wasm is missing)");
  });
});
