import { describe, expect, test } from "bun:test";
import { ShellCommandReading, type ShellProgramRun } from "bounded/domain";
import { ProgramPrefix } from "./program-prefix.ts";

const PREFIX_ERROR = "A rule's before.execute is a program and its leading arguments as the program receives them, separated by spaces: ";

const prefix = (raw: unknown): ProgramPrefix => {
  const parsed = ProgramPrefix.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const error = (raw: unknown): string => {
  const parsed = ProgramPrefix.parse(raw);
  return parsed.ok ? "accepted" : parsed.error;
};

/** A word only the shell can resolve, as the reader reports it. */
const unresolved = (text: string) => ({ kind: "unresolved", text });
type Word = string | ReturnType<typeof unresolved>;
const wordOf = (word: Word) => (typeof word === "string" ? { kind: "literal", text: word } : word);
/** A program run: its name and arguments, each literal unless given as unresolved(…). */
const run = (name: Word, args: readonly Word[] = []) => ({ name: wordOf(name), arguments: args.map(wordOf), workingDirectory: "." });
type Run = ReturnType<typeof run>;
/** A read reading of a command that runs `programs` and leaves `parts` unresolved. */
function reading(programs: readonly Run[], parts: readonly { text: string; role: string }[] = []): ShellCommandReading {
  const parsed = ShellCommandReading.parse({ outcome: "read", programs, fileEffects: [], unresolved: parts });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
function unread(why: string, cause?: "too-complex"): ShellCommandReading {
  const parsed = ShellCommandReading.parse({ outcome: "unread", why, ...(cause === undefined ? {} : { cause }) });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
const terraformApply = prefix("terraform apply");
/** A run's wire form, as the reading gives it. */
const wireOf = (given: ShellProgramRun) => ({ name: { ...given.name }, arguments: given.arguments.map((word) => ({ ...word })), workingDirectory: given.workingDirectory?.value ?? null });
/** What `terraform apply` makes of a reading running `programs`: the run's wire form when it runs, else why and fix. */
const matched = (programs: readonly Run[], parts: readonly { text: string; role: string }[] = [], given = terraformApply) => {
  const match = given.matchIn(reading(programs, parts));
  return match.kind === "runs" ? { kind: match.kind, run: wireOf(match.run) } : match;
};
const kindOf = (programs: readonly Run[], given = terraformApply): string => given.matchIn(reading(programs)).kind;

describe("ProgramPrefix — a program and its leading arguments, as a rule's before.execute names them", () => {
  test("a program prefix is a program and its subcommand words, as the program receives them", () => {
    expect(prefix("terraform apply").program).toBe("terraform");
    expect(prefix("terraform apply").leadingArguments).toEqual(["apply"]);
    expect(prefix("  terraform   apply ").toJSON()).toBe("terraform apply");
    expect(JSON.stringify(prefix("  terraform   apply "))).toBe('"terraform apply"');
    expect(prefix("make").program).toBe("make");
    expect(prefix("make").leadingArguments).toEqual([]);
    expect(prefix("git push origin").leadingArguments).toEqual(["push", "origin"]);
    expect(Object.isFrozen(prefix("terraform apply"))).toBe(true);
    expect(Object.isFrozen(prefix("terraform apply").leadingArguments)).toBe(true);
    expect(prefix("terraform apply").equals(prefix(" terraform apply"))).toBe(true);
    expect(prefix("terraform apply").equals(prefix("terraform plan"))).toBe(false);
  });

  test("a prefix is refused when it is not text, empty, too long, has more than 16 words, holds control characters, other whitespace or shell syntax, names its program by a path, or is not a program and its subcommand words", () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [42, "it is not text"],
      [["terraform", "apply"], "it is not text"],
      ["", "it is empty"],
      ["   ", "it is empty"],
      ["a\u0007b", "it holds a control character"],
      ["terraform\tapply", "it holds whitespace other than a space"],
      ["terraform apply", "it holds whitespace other than a space"],
      ["a".repeat(1001), "it is longer than 1000 characters"],
      [Array.from({ length: 17 }, (_, index) => `w${index}`).join(" "), "it has more than 16 words"],
      ["terraform 'apply'", "it holds ''', which the shell would read, not pass on"],
      ['terraform "apply"', "it holds '\"', which the shell would read, not pass on"],
      ["terraform\\ apply", "it holds '\\', which the shell would read, not pass on"],
      ["$TF apply", "it holds '$', which the shell would read, not pass on"],
      ["terraform apply*", "it holds '*', which the shell would read, not pass on"],
      ["terraform apply; rm x", "it holds ';', which the shell would read, not pass on"],
      ["terraform `x`", "it holds '`', which the shell would read, not pass on"],
      ["terraform apply # now", "it holds '#', which the shell would read, not pass on"],
      ["./deploy.sh", "the program is named by itself, not by a path ('./deploy.sh')"],
      ["bin/terraform apply", "the program is named by itself, not by a path ('bin/terraform')"],
      ["~/bin/tf apply", "the program holds '~', which the shell expands to a home directory"],
      ["TF_LOG=1 terraform", "the program holds '=', so the shell would read the word as an assignment, not a program"],
      ["time terraform apply", "'time' is a word of the shell's own grammar, not a program"],
      ["if terraform", "'if' is a word of the shell's own grammar, not a program"],
      ["! terraform", "'!' is a word of the shell's own grammar, not a program"],
      ["coproc terraform", "'coproc' is a word of the shell's own grammar, not a program"],
      ["-x terraform", "the program starts with '-', so it is an option, not a program"],
      ["terraform -chdir=infra apply", "'-chdir=infra' starts with '-': a rule names its program and subcommand words, never an option"],
      ["git push --force", "'--force' starts with '-': a rule names its program and subcommand words, never an option"],
    ];
    for (const [raw, why] of cases) expect({ raw, error: error(raw) }).toEqual({ raw, error: `${PREFIX_ERROR}${why}` });
    expect(error("a".repeat(1000))).toBe("accepted");
    expect(error(Array.from({ length: 16 }, (_, index) => `w${index}`).join(" "))).toBe("accepted");
  });

  test("a command runs the prefix when a program it runs is that program, by name or path, ignoring case, with the prefix's words", () => {
    const runs = [
      [run("terraform", ["apply"])],
      [run("terraform", ["apply", "-auto-approve"])],
      [run("/usr/local/bin/terraform", ["apply"])],
      [run("./terraform", ["apply"])],
      [run("Terraform", ["apply"])],
      [run("sudo", ["terraform", "apply"]), run("terraform", ["apply"])],
      [run("bash", ["-c", "terraform apply"]), run("terraform", ["apply"])],
    ];
    for (const programs of runs) {
      const match = terraformApply.matchIn(reading(programs));
      expect({ programs, kind: match.kind }).toEqual({ programs, kind: "runs" });
      expect(match.kind === "runs" && wireOf(match.run)).toEqual(programs.at(-1) as Run);
    }
    // A prefix of the program alone runs whatever its arguments.
    expect(kindOf([run("make", ["build"])], prefix("make"))).toBe("runs");
    expect(kindOf([run("make")], prefix("make"))).toBe("runs");
  });

  test("words are exact: another subcommand, case or program does not run the prefix", () => {
    for (const programs of [[run("terraform", ["plan"])], [run("terraform", ["APPLY"])], [run("terraform")], [run("terraformer", ["apply"])], [run("terraform.exe", ["apply"])]]) {
      expect({ programs, kind: kindOf(programs) }).toEqual({ programs, kind: "does-not-run" });
    }
    expect(kindOf([run("git", ["log", "push"])], prefix("git push"))).toBe("does-not-run");
  });

  test("options before the words are looked past, an option possibly taking the next word (every plausible reading)", () => {
    expect(kindOf([run("terraform", ["-chdir=infra", "apply"])])).toBe("runs");
    expect(kindOf([run("git", ["-C", "sub", "push"])], prefix("git push"))).toBe("runs");
    expect(kindOf([run("git", ["-c", "a=b", "push"])], prefix("git push"))).toBe("runs");
    expect(kindOf([run("git", ["--no-pager", "push"])], prefix("git push"))).toBe("runs");
    expect(kindOf([run("terraform", ["--", "apply"])])).toBe("runs");
    // --no-pager may take log as its value: fails closed.
    expect(kindOf([run("git", ["--no-pager", "log", "push"])], prefix("git push"))).toBe("runs");
    expect(kindOf([run("terraform", ["plan", "-chdir=x", "apply"])])).toBe("does-not-run");
    // After --, an option word is an argument like any other.
    expect(kindOf([run("terraform", ["--", "-x", "apply"])])).toBe("does-not-run");
  });

  test("any unresolved argument reached before every word is found cannot be seen, whatever its first character", () => {
    for (const programs of [
      [run("terraform", [unresolved("$CMD")])],
      [run("terraform", [unresolved('"-$X"')])],
      [run("terraform", [unresolved("-$(echo x apply)")])],
      [run("terraform", [unresolved('-chdir="$D"'), "apply"])],
    ]) {
      const match = terraformApply.matchIn(reading(programs));
      expect({ programs, kind: match.kind, fix: match.kind === "cannot-see" && match.fix }).toEqual({ programs, kind: "cannot-see", fix: "readable" });
    }
    // An unresolved option value counts too.
    expect(kindOf([run("git", ["-C", unresolved("$D"), "push"])], prefix("git push"))).toBe("cannot-see");
    expect(matched([run("/usr/local/bin/terraform", [unresolved("$CMD")])])).toEqual({
      kind: "cannot-see",
      why: "'$CMD', which only the shell can resolve, stands before /usr/local/bin/terraform's argument 'apply' could be found",
      fix: "readable",
    });
    expect(kindOf([run("terraform", ["plan", unresolved("$X")])])).toBe("does-not-run");
    // A word found before the unresolved one leaves nothing to find: it runs.
    expect(kindOf([run("terraform", ["apply", unresolved("$X")])])).toBe("runs");
  });

  test("a run that passes the program as an argument, or as a word of one, cannot be seen through: it may run it", () => {
    const cases: readonly (readonly [Run, string])[] = [
      [run("/usr/bin/env", ["terraform", "apply"]), "it passes 'terraform' to /usr/bin/env, which may run terraform"],
      [run("/bin/bash", ["-c", "terraform apply"]), "it passes 'terraform apply' to /bin/bash, which may run terraform"],
      [run("trap", ["terraform apply", "EXIT"]), "it passes 'terraform apply' to trap, which may run terraform"],
      [run("aws-vault", ["exec", "prof", "--", "terraform", "apply"]), "it passes 'terraform' to aws-vault, which may run terraform"],
      [run("watch", ["terraform apply"]), "it passes 'terraform apply' to watch, which may run terraform"],
      [run("echo", ["terraform"]), "it passes 'terraform' to echo, which may run terraform"],
      [run("which", ["terraform"]), "it passes 'terraform' to which, which may run terraform"],
      [run("git", ["commit", "-m", "bump Terraform"]), "it passes 'bump Terraform' to git, which may run terraform"],
      [run("ssh", ["host", "/opt/bin/terraform", "apply"]), "it passes '/opt/bin/terraform' to ssh, which may run terraform"],
    ];
    for (const [given, why] of cases) expect(matched([given])).toEqual({ kind: "cannot-see", why, fix: "none" });
    expect(kindOf([run("echo", ["terraformer"])])).toBe("does-not-run");
    expect(kindOf([run("git", ["commit", "-m", "bump terraform-docs"])])).toBe("does-not-run");
  });

  test("where it cannot see, it says so, and what would let it see", () => {
    expect(terraformApply.matchIn(unread("bounded's shell parser could not load (main.wasm is missing)"))).toEqual({
      kind: "cannot-see",
      why: "the command could not be read (bounded's shell parser could not load (main.wasm is missing))",
      fix: "reinstall",
    });
    expect(terraformApply.matchIn(unread("the command is too complex to read", "too-complex"))).toEqual({ kind: "cannot-see", why: "the command could not be read (the command is too complex to read)", fix: "simplify" });
    expect(matched([run(unresolved("$TF"), ["apply"])])).toEqual({ kind: "cannot-see", why: "it runs a program whose name only the shell can resolve ('$TF')", fix: "readable" });
    expect(matched([run(unresolved("(input)"), ["apply"])])).toEqual({ kind: "cannot-see", why: "it runs a program whose name only the shell can resolve ('(input)')", fix: "readable" });
    expect(matched([run("terraform", [unresolved("(input)")])])).toEqual({ kind: "cannot-see", why: "'(input)', which only the shell can resolve, stands before terraform's argument 'apply' could be found", fix: "readable" });
    expect(matched([run("terraform", [unresolved("(found path)")])])).toEqual({ kind: "cannot-see", why: "'(found path)', which only the shell can resolve, stands before terraform's argument 'apply' could be found", fix: "readable" });
    expect(matched([run("sh")], [{ text: "(standard input)", role: "code" }])).toEqual({ kind: "cannot-see", why: "it runs code bounded cannot read ('(standard input)')", fix: "none" });
    // Unresolved parts that are not code run nothing.
    expect(kindOf([run("cat", [unresolved("$X")])])).toBe("does-not-run");
    expect(terraformApply.matchIn(reading([run("cat", [unresolved("$X")])], [{ text: "$X", role: "read" }])).kind).toBe("does-not-run");
  });

  test("what cannot be seen is told in order: a program's name, then an argument, then code, then a run passing the program", () => {
    const name = run(unresolved("$TF"));
    const argument = run("terraform", [unresolved("$X")]);
    const passes = run("echo", ["terraform"]);
    const code = { text: "eval x", role: "code" };
    expect(matched([passes, argument, name], [code])).toMatchObject({ why: "it runs a program whose name only the shell can resolve ('$TF')" });
    expect(matched([passes, argument], [code])).toMatchObject({ why: "'$X', which only the shell can resolve, stands before terraform's argument 'apply' could be found" });
    expect(matched([passes], [code])).toMatchObject({ why: "it runs code bounded cannot read ('eval x')" });
    expect(matched([passes])).toMatchObject({ why: "it passes 'terraform' to echo, which may run terraform" });
  });

  test("a run beats what cannot be seen", () => {
    const match = terraformApply.matchIn(reading([run(unresolved("$TF")), run("echo", ["terraform"]), run("terraform", ["apply"])], [{ text: "(standard input)", role: "code" }]));
    expect(match.kind).toBe("runs");
    expect(match.kind === "runs" && wireOf(match.run)).toEqual(run("terraform", ["apply"]));
  });
});
