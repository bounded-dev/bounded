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
const INSTALL_SCRIPT = join(import.meta.dir, "../../../test/fixtures/install.sh");
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

  /** What the reader makes of `command`, how long it took, and the reading parsed. */
  async function timed(command: string, reader = new TreeSitterShellCommandReader({ pathKindOf: () => "absent" })) {
    const started = performance.now();
    const reading = made(ShellCommandReading.parse(await reader.read(ROOT, made(Command.parse(command)), null)));
    return { elapsed: performance.now() - started, reading };
  }

  test("a command past the length limit is unread before it is parsed, saying so, as too complex", async () => {
    const { elapsed, reading } = await timed(`echo ${"a".repeat(65_536)}`);
    expect(elapsed).toBeLessThan(2000);
    expect(reading.toJSON()).toEqual({ outcome: "unread", why: "the command is too long to read: 65541 characters, past bounded's limit of 65536", cause: "too-complex" });
  });

  test("a long heredoc is read: its body is text, whatever its words", async () => {
    const command = `cat > notes.txt <<'EOF'\n${"a line of the heredoc body\n".repeat(2300)}EOF`;
    expect(command.length).toBeGreaterThan(60_000);
    const { elapsed, reading } = await timed(command);
    expect(elapsed).toBeLessThan(2000);
    expect(reading.outcome === "read" && reading.toJSON().fileEffects).toEqual([{ effect: { kind: "write", path: "notes.txt", change: "create" } }]);
  });

  test("brace expansion is bounded: what costs too much is unread as too complex, quickly; quoted and escaped braces never count", async () => {
    const costly = await timed(`cat ${"{a,b}".repeat(10_000)}`);
    expect(costly.elapsed).toBeLessThan(2000);
    expect(costly.reading.toJSON()).toEqual({ outcome: "unread", why: "the command is too complex to read: expanding its braces would take more work than bounded allows", cause: "too-complex" });
    const json = JSON.stringify(Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`key${index}`, { name: `value ${index}`, tags: ["a", "b"] }])));
    expect(json.length).toBeGreaterThan(4000);
    for (const command of [`echo '{${"a".repeat(4100)}'`, `curl -X POST -d '${json}' https://example.com/api`, `echo \\{${"a".repeat(4100)}`]) {
      const { elapsed, reading } = await timed(command);
      expect({ command: command.slice(0, 30), fast: elapsed < 2000, outcome: reading.outcome }).toEqual({ command: command.slice(0, 30), fast: true, outcome: "read" });
    }
    // Below the bound, braces still expand.
    expect((await read(`cat ${"{a,b}".repeat(8)}`)).fileEffects).toHaveLength(256);
    expect((await read(`cat ${"{a,b}".repeat(9)}`)).unresolved).toEqual([{ text: "{a,b}".repeat(9), role: "read" }]);
    expect((await read("cat {a,b}.txt")).fileEffects).toEqual([{ effect: { kind: "read", path: "a.txt" } }, { effect: { kind: "read", path: "b.txt" } }]);
  });

  test("the reviewer's pathological commands each finish in under 2 s, read or unread", async () => {
    for (const command of [
      `${"xargs --b ".repeat(14)}sh -c '${"cat a.txt; ".repeat(370)}'`,
      `echo ${"{".repeat(4096)}${"}".repeat(4096)}`,
      `echo ${`${"{".repeat(4096)} `.repeat(15)}`,
      `echo ${"{".repeat(60_000)}`,
    ]) {
      const { elapsed } = await timed(command);
      expect({ command: command.slice(0, 30), fast: elapsed < 2000 }).toEqual({ command: command.slice(0, 30), fast: true });
    }
  }, 30_000);

  test("a syntax tree nested past the walk's depth is unread as too complex, never a stack overflow", async () => {
    const { elapsed, reading } = await timed(`${"(".repeat(30_000)}${")".repeat(30_000)}`);
    expect(elapsed).toBeLessThan(2000);
    expect(reading.toJSON()).toEqual({ outcome: "unread", why: "the command is too complex to read: it nests more than 1000 levels deep", cause: "too-complex" });
    expect((await read(`${"( ".repeat(500)}rm x${" )".repeat(500)}`)).fileEffects).toEqual([{ effect: { kind: "write", path: "x", change: "delete" } }]);
  });

  test("the backstop: past its deadline on the reader's clock, a command is unread as too complex, however its work is counted", async () => {
    // A clock that runs out after the deadline is set: every later look finds the time spent.
    let ticks = 0;
    const clock = () => (ticks++ === 0 ? 0 : 1001);
    const { reading } = await timed("cat a.txt", new TreeSitterShellCommandReader({ pathKindOf: () => "absent", clock }));
    expect(reading.toJSON()).toEqual({ outcome: "unread", why: "the command is too complex to read within the time bounded allows for one command (parsing it)", cause: "too-complex" });
    // A clock that never moves never runs out.
    expect((await timed("cat a.txt", new TreeSitterShellCommandReader({ pathKindOf: () => "absent", clock: () => 0 }))).reading.outcome).toBe("read");
    // The deadline is measured on the reader's clock, not the wall's: on one that never moves, even a 1 ms deadline never runs out. (Each check site, the domain's included, is tested in shell-command-effects.test.ts.)
    const quiet = new TreeSitterShellCommandReader({ pathKindOf: () => "absent", clock: () => 0, readDeadlineMs: 1 });
    expect((await timed("cat a.txt", quiet)).reading.outcome).toBe("read");
  });

  test("readDeadlineMs is a finite number of milliseconds above zero", () => {
    for (const readDeadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new TreeSitterShellCommandReader({ readDeadlineMs })).toThrow(new RangeError("readDeadlineMs must be a finite number of milliseconds above zero"));
    }
  });

  test("brace passes are linear and the deadline reaches inside them: the reviewer's cases each finish in under 1.5 s", async () => {
    for (const command of [
      `echo ${"{".repeat(32_765)}${"}".repeat(32_765)}`,
      `echo {${".".repeat(65_000)}\\x}`,
      `echo ${"{".repeat(2000)}${".".repeat(60_000)}\\x${"}".repeat(2000)}`,
      // A short option cluster read for every value it could carry costs its suffixes, counted without overflow.
      `grep -${"a".repeat(65_000)}`,
      // Where a deep cd took later commands: carrying it costs in proportion to its depth.
      `cd ${"a/".repeat(16_000)} && ${"if a; then cat b; fi; ".repeat(1400)}`,
      `cd ${"a/".repeat(16_000)} && cat ${"b ".repeat(3000)}`,
    ]) {
      const { elapsed } = await timed(command);
      expect({ command: command.slice(0, 30), fast: elapsed < 1500 }).toEqual({ command: command.slice(0, 30), fast: true });
    }
  }, 30_000);

  /** mulberry32 from a fixed seed: the same numbers in [0, 1) every run. */
  const seededRandom = (seed: number) => (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Reads every command in `commands` with one reader: each must give a usable reading, never throw, never be unread for time; gives the slowest read in ms. */
  async function slowestRead(commands: readonly string[]): Promise<number> {
    const reader = new TreeSitterShellCommandReader({ pathKindOf: () => "absent" });
    let worst = 0;
    for (const [case_, text] of commands.entries()) {
      const command = Command.parse(text.trim() === "" ? "x" : text);
      if (!command.ok) continue;
      const started = performance.now();
      const answer = await reader.read(ROOT, command.value, null);
      const elapsed = performance.now() - started;
      worst = Math.max(worst, elapsed);
      const parsed = ShellCommandReading.parse(answer);
      const unreadForTime = parsed.ok && parsed.value.outcome === "unread" && parsed.value.why.includes("within the time");
      expect({ case_, fast: elapsed < 1500, unreadForTime, parses: parsed.ok ? "ok" : `${parsed.error} in ${JSON.stringify(text.slice(0, 200))}` }).toEqual({ case_, fast: true, unreadForTime: false, parses: "ok" });
    }
    console.log(`slowest of ${commands.length} reads: ${worst.toFixed(1)} ms`);
    return worst;
  }

  test("fuzz: a few hundred random commands of shell metacharacters and words, up to 65,536 characters, each read in under 250 ms, never throwing, never unread for time", async () => {
    const random = seededRandom(0x2026_0020);
    const pieces = ["{", "}", "(", ")", "$", "`", "'", '"', "\\", ".", ",", ";", "&", "|", "<", ">", "*", "?", "[", "]", " ", "\n", "xargs", "sh -c", "cat", "rm", "cd", "-", "--b", "..", "a", "1", "{a,b}", "$(", "<<EOF\n", "EOF\n"];
    const commands = Array.from({ length: 300 }, (_, case_) => {
      // Most short, some long, a few at the limit.
      const length = case_ % 10 === 0 ? 65_536 : case_ % 3 === 0 ? Math.floor(random() * 20_000) : Math.floor(random() * 400) + 1;
      let text = "";
      while (text.length < length) text += pieces[Math.floor(random() * pieces.length)];
      return text.slice(0, length);
    });
    expect(await slowestRead(commands)).toBeLessThan(250);
  }, 600_000);

  test("fuzz: balanced nests (brace groups, command substitutions, ifs and cases), seeded, up to 65,536 characters, each read in under 250 ms, never unread for time", async () => {
    const random = seededRandom(0x2026_0021);
    const pick = <T>(choices: readonly T[]): T => choices[Math.floor(random() * choices.length)] as T;
    /** A balanced nest `depth` deep, of one kind or mixed, around a leaf. */
    const nest = (depth: number, kind: string): string => {
      if (depth === 0) return pick(["cat a.txt", "rm b", "echo {a,b}", "x", "cat {1..3}.log"]);
      const inner = nest(depth - 1, kind === "mixed" ? pick(["brace", "substitution", "if", "case"]) : kind);
      switch (kind) {
        case "brace":
          return `echo {${inner.replace(/ /g, "_")},b}`;
        case "substitution":
          return `echo $( ${inner} )`;
        case "if":
          return `if ${pick(["true", "a"])}; then ${inner}; fi`;
        default:
          return `case x in a) ${inner};; esac`;
      }
    };
    const commands: string[] = [];
    for (let case_ = 0; case_ < 120; case_++) {
      const kind = pick(["brace", "substitution", "if", "case", "mixed"]);
      const depth = case_ % 6 === 0 ? 900 + Math.floor(random() * 200) : Math.floor(random() * 120) + 1;
      const once = nest(depth, kind);
      // Some repeated side by side, up to the length limit.
      const copies = case_ % 4 === 0 ? Math.max(1, Math.floor(65_536 / (once.length + 2))) : 1;
      commands.push(Array.from({ length: copies }, () => once).join("; ").slice(0, 65_536));
    }
    expect(await slowestRead(commands)).toBeLessThan(250);
  }, 600_000);

  test("the outcomes ADR 2026-020 quotes: each as stated, in under 1.5 s, none for want of time", async () => {
    const json = JSON.stringify(Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`key${index}`, { name: `value ${index}`, tags: ["a", "b"] }])));
    const cases: readonly (readonly [string, "read" | "unread"])[] = [
      [await Bun.file(INSTALL_SCRIPT).text(), "read"],
      [`cat > notes.txt <<'EOF'\n${"a line of the heredoc body\n".repeat(2300)}EOF`, "read"],
      [`cat ${"w ".repeat(5000)}`, "read"],
      [`echo ${"a ".repeat(25_000)}`, "read"],
      [`curl -X POST -d '${json}' https://example.com/api`, "read"],
      [`echo ${"{".repeat(32_765)}${"}".repeat(32_765)}`, "read"],
      [`echo {${".".repeat(65_000)}\\x}`, "read"],
      [`echo ${"{".repeat(2000)}${".".repeat(60_000)}\\x${"}".repeat(2000)}`, "read"],
      [`echo ${"{".repeat(60_000)}`, "read"],
      [`${"xargs $A ".repeat(24)}true ${"w ".repeat(5000)}`, "unread"],
      [`${"xargs --b ".repeat(14)}sh -c '${"cat a.txt; ".repeat(370)}'`, "unread"],
      [`cat ${"{a,b}".repeat(10_000)}`, "unread"],
      [`${"(".repeat(30_000)}${")".repeat(30_000)}`, "unread"],
      [`grep -${"a".repeat(65_000)}`, "unread"],
      [`cd ${"a/".repeat(16_000)} && ${"if a; then cat b; fi; ".repeat(1400)}`, "unread"],
      // One long directory costs as many short ones do: carrying it is charged per character.
      [`cd ${"a".repeat(30_000)} && cat ${"b ".repeat(15_000)}`, "unread"],
      [`cd ${"a".repeat(30_000)} && ${"if a; then cat b; fi; ".repeat(1400)}`, "unread"],
    ];
    for (const [command, outcome] of cases) {
      const { elapsed, reading } = await timed(command);
      const forTime = reading.outcome === "unread" && reading.why.includes("within the time");
      expect({ command: command.slice(0, 30), fast: elapsed < 1500, outcome: reading.outcome, forTime }).toEqual({ command: command.slice(0, 30), fast: true, outcome, forTime: false });
    }
  }, 60_000);

  test("a long group of digits and dots that is no range stays a literal word, as in bash", async () => {
    const word = `secret{${Array.from({ length: 17 }, (_, index) => index + 1).join("..")}}`;
    expect(word.length).toBeGreaterThan(48);
    expect((await read(`cat ${word}`)).fileEffects).toEqual([{ effect: { kind: "read", path: word } }]);
    // A group that is no range leaves the next one to expand, as in bash.
    expect((await read("cat a{1..a}{x,y}")).fileEffects).toEqual([{ effect: { kind: "read", path: "a{1..a}x" } }, { effect: { kind: "read", path: "a{1..a}y" } }]);
    // A long numeric range is sliced too: padded, it is spelt out both ways; past the word cap, unresolved.
    expect((await read(`cat {${"0".repeat(30)}1..${"0".repeat(30)}2}`)).fileEffects).toHaveLength(4);
    expect((await read(`cat {${"0".repeat(30)}1..${"0".repeat(30)}999}`)).unresolved).toEqual([{ text: `{${"0".repeat(30)}1..${"0".repeat(30)}999}`, role: "read" }]);
  });

  test("zero-padded ranges give both shells' words: padded (bash 4, zsh) and not (bash 3.2)", async () => {
    const deleted = async (command: string) => (await read(command)).fileEffects.map(({ effect }) => (effect.kind === "write" ? effect.path : effect.kind));
    expect(await deleted("rm key{01..02}.pem")).toEqual(["key1.pem", "key01.pem", "key2.pem", "key02.pem"]);
    expect(await deleted("rm f{08..10}")).toEqual(["f8", "f08", "f9", "f09", "f10"]);
    expect(await deleted("rm f{1..010}")).toEqual(Array.from({ length: 10 }, (_, index) => [`f${index + 1}`, `f${String(index + 1).padStart(3, "0")}`]).flat());
    // A negative padded end: the shells disagree on its width, so it is unresolved.
    expect((await read("rm f{-01..1}")).unresolved).toEqual([{ text: "f{-01..1}", role: "write" }]);
  });

  test("stepped ranges give bash 4's and zsh's words, and the word as written, which bash 3.2 keeps literal", async () => {
    const deleted = async (command: string) => (await read(command)).fileEffects.map(({ effect }) => (effect.kind === "write" ? effect.path : effect.kind));
    expect(await deleted("rm f{1..5..2}")).toEqual(["f1", "f3", "f5", "f{1..5..2}"]);
    expect(await deleted("rm f{5..1..2}")).toEqual(["f5", "f3", "f1", "f{5..1..2}"]);
    expect(await deleted("rm f{a..e..2}")).toEqual(["fa", "fc", "fe", "f{a..e..2}"]);
    expect(await deleted("rm f{01..05..2}")).toEqual(["f1", "f01", "f3", "f03", "f5", "f05", "f{01..05..2}"]);
    // A step of zero or below: the shells disagree on its words, so it is unresolved.
    for (const command of ["rm f{1..5..0}", "rm f{1..5..-2}"]) expect((await read(command)).unresolved).toEqual([{ text: command.slice(3), role: "write" }]);
    // Within the word cap a stepped range expands; past it, the word is unresolved as before.
    expect((await read("rm f{0..1000..4}")).fileEffects).toHaveLength(252);
    expect((await read("rm f{0..1000..2}")).unresolved).toEqual([{ text: "f{0..1000..2}", role: "write" }]);
  });

  test("a token the parser inserted to recover is named for what it is, never an empty word; a quoted empty word stays one", async () => {
    const recovered = await read("cat a |");
    expect(recovered.programs.map((program) => program.name)).toEqual([{ kind: "literal", text: "cat" }, { kind: "unresolved", text: "(a token the parser inserted to recover)" }]);
    expect((await read("a && ")).programs.at(-1)?.name).toEqual({ kind: "unresolved", text: "(a token the parser inserted to recover)" });
    expect((await read('"" a')).programs.map((program) => program.name)).toEqual([{ kind: "literal", text: "" }]);
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
