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
/** A realistic install script (test/fixtures/install.sh): lists, if, for, while, case, $(...), a heredoc, sudo, git -C and one xargs. */
const INSTALL_SCRIPT = join(import.meta.dir, "../../../../test/fixtures/install.sh");
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

  test("inline code given in a cluster of short options is unresolved code too, as getopt reads the cluster", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["perl -ne 'print if /x/' data.csv", "print if /x/"],
      ["perl -pe 's/a/b/' data.csv", "s/a/b/"],
      ["perl -lne 'print' data.csv", "print"],
      ["perl -pi -e 's/a/b/' data.csv", "s/a/b/"],
      ["node -pe 'process.version'", "process.version"],
      ["ruby -ne 'puts $_' data.csv", "puts $_"],
      ["python3 -Bc 'print(1)' data.csv", "print(1)"],
      ["python3 -c'print(1)'", "print(1)"],
    ];
    for (const [command, code] of cases) {
      const reading = await read(command);
      expect({ command, unresolved: reading.unresolved }).toEqual({ command, unresolved: expect.arrayContaining([{ text: code, role: "code" }]) });
    }
    // A letter that takes a value ends the cluster: perl's -M takes the rest of its word, here a module.
    expect((await read("perl -Mfeature=say data.csv")).unresolved).toEqual([]);
  });

  test("xargs's literal words are judged as written; its input is only reported, never an operand", async () => {
    const replaced = await read("echo a | xargs -I % cp % out/a.txt");
    expect(replaced.programs.at(-1)?.arguments).toEqual([{ kind: "literal", text: "%" }, { kind: "literal", text: "out/a.txt" }]);
    expect(replaced.fileEffects).toEqual([{ effect: { kind: "read", path: "%" } }, { effect: { kind: "write", path: "out/a.txt", change: "create" } }]);
    expect(replaced.unresolved).toEqual([{ text: "(input)", role: "read" }]);
    const appended = await read("ls | xargs cp a.txt out/a.txt");
    expect(appended.fileEffects).toContainEqual({ effect: { kind: "write", path: "out/a.txt", change: "create" } });
    expect(appended.unresolved).toContainEqual({ text: "(input)", role: "write" });
    expect((await read("ls | xargs rm")).unresolved).toEqual([{ text: "(input)", role: "write" }]);
    expect((await read("ls | xargs grep -i x")).programs.at(-1)?.arguments.at(-1)).toEqual({ kind: "unresolved", text: "(input)" });
  });

  test("with a replace string, every word is still judged as written, and the input is reported where the string stands, with the role the command gives it", async () => {
    const removed = await read("echo a | xargs -I % rm %");
    expect(removed.fileEffects).toEqual([{ effect: { kind: "write", path: "%", change: "delete" } }]);
    expect(removed.unresolved).toEqual([{ text: "(input)", role: "write" }]);
    const moved = await read("echo a | xargs -I % mv % %.bak");
    expect(moved.fileEffects).toContainEqual({ effect: { kind: "write", path: "%.bak", change: "create" } });
    expect(moved.unresolved).toEqual([
      { text: "(input)", role: "read" },
      { text: "(input)", role: "write" },
    ]);
    // A replace string only the shell can resolve stands nowhere known: the input is reported as code, and the words judged as written.
    expect((await read("echo a | xargs -I $R rm old.txt")).unresolved).toEqual([{ text: "(input)", role: "code" }]);
  });

  test("every way to give xargs a replace string is one: -I, --replace=X, a bare --replace or -i ({}), -iX and BSD -J", async () => {
    for (const [command, replaced] of [
      ["xargs -I % rm %", "%"],
      ["xargs --replace=% rm %", "%"],
      ["xargs --repl=% rm %", "%"],
      ["xargs -i rm {}", "{}"],
      ["xargs --replace rm {}", "{}"],
      ["xargs -i% rm %", "%"],
      ["xargs -J % rm %", "%"],
      ["xargs -0I % rm %", "%"],
      ["xargs -rI % rm %", "%"],
    ] as const) {
      const reading = await read(command);
      // With one, no input is appended: the command's words are only those written, each judged as written.
      expect({ command, arguments: reading.programs.at(-1)?.arguments, fileEffects: reading.fileEffects, unresolved: reading.unresolved }).toEqual({
        command,
        arguments: [{ kind: "literal", text: replaced }],
        fileEffects: [{ effect: { kind: "write", path: replaced, change: "delete" } }],
        unresolved: [{ text: "(input)", role: "write" }],
      });
    }
    // Without one, the literal words are judged as written, and the input comes after them.
    for (const command of ["xargs -l rm old.txt", "xargs --max-args 1 rm old.txt", "xargs -n1 rm old.txt", "xargs -L 1 -P 2 rm old.txt", "xargs -R 1 -S 255 rm old.txt", "xargs --max-lines rm old.txt"]) {
      const reading = await read(command);
      expect({ command, fileEffects: reading.fileEffects, unresolved: reading.unresolved, last: reading.programs.at(-1)?.arguments.at(-1) }).toEqual({
        command,
        fileEffects: [{ effect: { kind: "write", path: "old.txt", change: "delete" } }],
        unresolved: [{ text: "(input)", role: "write" }],
        last: { kind: "unresolved", text: "(input)" },
      });
    }
  });

  test("xargs's long options match by unique prefix, as getopt_long matches them", async () => {
    for (const command of ["xargs --arg in.txt rm old.txt", "xargs --del , rm old.txt", "xargs --max-p 2 rm old.txt", "xargs --proc SLOT rm old.txt", "xargs --max-a 1 rm old.txt"]) {
      const reading = await read(command);
      expect({ command, programs: reading.programs.map((program) => program.name.text) }).toEqual({ command, programs: ["xargs", "rm"] });
      expect({ command, deletes: reading.fileEffects.filter(({ effect }) => effect.kind === "write") }).toEqual({ command, deletes: [{ effect: { kind: "write", path: "old.txt", change: "delete" } }] });
    }
    expect((await read("xargs --arg in.txt rm old.txt")).fileEffects).toContainEqual({ effect: { kind: "read", path: "in.txt" } });
  });

  test("where xargs's command cannot be told, every plausible reading is judged and the words are also operands: nothing leaves judgement", async () => {
    for (const command of ["xargs --max 1 rm old.txt", "xargs --bogus rm old.txt", 'xargs "$OPTS" rm old.txt', 'xargs -d"$D" rm old.txt', "xargs $OPTS 1 rm old.txt"]) {
      const reading = await read(command);
      expect({ command, deletes: reading.fileEffects.filter(({ effect }) => effect.kind === "write") }).toEqual({ command, deletes: [{ effect: { kind: "write", path: "old.txt", change: "delete" } }] });
      expect({ command, reads: reading.fileEffects.some(({ effect }) => effect.kind === "read" && effect.path.endsWith("old.txt")) }).toEqual({ command, reads: true });
    }
  });

  test("a command whose plausible readings or nesting outgrow the work budget comes back unread, quickly, never as a reduced reading", async () => {
    const reader = new TreeSitterShellCommandReader({ pathKindOf: () => "absent" });
    for (const command of [
      `${"xargs $A ".repeat(24)}true`,
      `${"xargs --b ".repeat(24)}true`,
      `xargs ${"--b ".repeat(30)}rm .git/hooks/pre-commit`,
      `${"xargs ".repeat(200)}true`,
      `${"sudo ".repeat(200)}rm x`,
      // Few readings, each slicing thousands of words: the budget counts the work, not the calls.
      `${"xargs $A ".repeat(24)}true ${"w ".repeat(5000)}`,
      `${"xargs $A ".repeat(24)}touch ${"w ".repeat(5000)}`,
    ]) {
      const started = performance.now();
      const reading = made(ShellCommandReading.parse(await reader.read(ROOT, made(Command.parse(command)), null)));
      const elapsed = performance.now() - started;
      expect({ command: command.slice(0, 40), fast: elapsed < 2000, outcome: reading.outcome }).toEqual({ command: command.slice(0, 40), fast: true, outcome: "unread" });
      expect(reading.outcome === "unread" && reading.why).toBe("the command is too complex to read within bounded's work budget (200000 steps): its words could be read too many ways, or it nests too deep");
      expect(reading.outcome === "unread" && reading.cause).toBe("too-complex");
    }
  }, 30_000);

  test("a command past the length limits is unread before it is parsed, saying which limit, as too complex", async () => {
    const reader = new TreeSitterShellCommandReader({ pathKindOf: () => "absent" });
    const cases: readonly (readonly [string, string])[] = [
      [`echo ${"a".repeat(65_536)}`, "the command is too long to read: 65541 characters, past bounded's limit of 65536"],
      [`echo ${"a ".repeat(10_000)}`, "the command is too long to read: 10001 words, past bounded's limit of 10000"],
    ];
    for (const [command, why] of cases) {
      const started = performance.now();
      const reading = made(ShellCommandReading.parse(await reader.read(ROOT, made(Command.parse(command)), null)));
      expect(performance.now() - started).toBeLessThan(2000);
      expect(reading.toJSON()).toEqual({ outcome: "unread", why, cause: "too-complex" });
    }
  });

  test("a word too long to brace-expand makes the command unread as too complex, quickly: brace expansion is bounded", async () => {
    const reader = new TreeSitterShellCommandReader({ pathKindOf: () => "absent" });
    const started = performance.now();
    const reading = made(ShellCommandReading.parse(await reader.read(ROOT, made(Command.parse(`cat ${"{a,b}".repeat(10_000)}`)), null)));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(reading.toJSON()).toEqual({ outcome: "unread", why: "the command is too complex to read: a word with a brace in it is longer than 4096 characters, past what bounded will brace-expand", cause: "too-complex" });
    // Below the bound, braces still expand.
    expect((await read(`cat ${"{a,b}".repeat(8)}`)).fileEffects).toHaveLength(256);
    expect((await read(`cat ${"{a,b}".repeat(9)}`)).unresolved).toEqual([{ text: "{a,b}".repeat(9), role: "read" }]);
    expect((await read("cat {a,b}.txt")).fileEffects).toEqual([{ effect: { kind: "read", path: "a.txt" } }, { effect: { kind: "read", path: "b.txt" } }]);
  });

  test("a realistic install script of about 500 lines is read, programs and all, well within the budget", async () => {
    const script = await Bun.file(INSTALL_SCRIPT).text();
    expect(script.split("\n").length).toBeGreaterThan(450);
    const reading = await read(script);
    const names = new Set(reading.programs.map((program) => program.name.text));
    for (const name of ["mkdir", "curl", "tar", "make", "sudo", "git", "xargs", "rm", "cp", "date", "tee"]) expect({ name, ran: names.has(name) }).toEqual({ name, ran: true });
    expect(reading.programs.length).toBeGreaterThan(300);
    // A cd to a directory only the shell can name leaves where later commands run unknown, so their paths are unresolved, never guessed.
    expect(reading.unresolved).toContainEqual({ text: '"$COMPONENT_DIR"', role: "directory" });
    expect(reading.unresolved).toContainEqual({ text: "vendor/postgres", role: "directory" });
  });

  test("commands nested just inside the limit are read; one level past it, unread", async () => {
    expect((await read(`${"sudo ".repeat(60)}rm x`)).fileEffects).toEqual([{ effect: { kind: "write", path: "x", change: "delete" } }]);
    expect((await read(`${"sh -c 'sudo ".repeat(20)}rm x${"'".repeat(20)}`)).programs.length).toBeGreaterThan(0);
    const reader = new TreeSitterShellCommandReader({ pathKindOf: () => "absent" });
    const past = made(ShellCommandReading.parse(await reader.read(ROOT, made(Command.parse(`${"sudo ".repeat(70)}rm x`)), null)));
    expect(past.outcome).toBe("unread");
  });

  test("xargs's input reaches the command a wrapper under it runs", async () => {
    const sudo = await read("ls | xargs sudo rm");
    expect(sudo.programs.map((program) => [program.name.text, program.arguments.map((word) => word.text)])).toEqual([
      ["ls", []],
      ["xargs", ["sudo", "rm"]],
      ["sudo", ["rm", "(input)"]],
      ["rm", ["(input)"]],
    ]);
    expect(sudo.unresolved).toEqual([{ text: "(input)", role: "write" }]);
    const env = await read("ls | xargs env -C d cp a");
    expect(env.programs.at(-1)).toEqual({ name: { kind: "literal", text: "cp" }, arguments: [{ kind: "literal", text: "a" }, { kind: "unresolved", text: "(input)" }], workingDirectory: "d" });
    expect(env.unresolved).toContainEqual({ text: "(input)", role: "write" });
  });

  test("perl's value letters (-d, -D, -F, -0, -M …) end a cluster before its code letter", async () => {
    expect((await read("perl -d:Trace -e 'print 1'")).unresolved).toEqual([{ text: "print 1", role: "code" }]);
    expect((await read("perl -F: -lane 'print $F[0]' x.txt")).unresolved).toEqual([{ text: "print $F[0]", role: "code" }]);
    expect((await read("perl -0777 -ne 'print' x.txt")).unresolved).toEqual([{ text: "print", role: "code" }]);
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
