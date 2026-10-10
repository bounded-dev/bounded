// End to end: a host opens a project selecting bounded/prereqs with its
// ports, reads each shell command with bounded's shell command reader, and
// the pack judges the reading: before: { execute } against the programs it
// runs, before: { write } against the files it writes, and what it cannot see
// refused while a rule does not hold (ADR 2026-019, amended; ADR 2026-020).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProject } from "bounded/open-project";
import { prereqsPortProvisions } from "bounded/prereqs/adapters";
import { protectedPathsPortProvisions } from "bounded/protected-paths/adapters";
import { openShellCommandReading } from "./shell-command-reading.ts";

/** The reading every command in these tests is read with, as a host reads it. */
const shellCommandReading = openShellCommandReading();

const CORE = resolve(import.meta.dir, "../../..");
// Snapshots go to the user's state directory: a temporary one here.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bounded-state-"));

const APPLY_REDIRECT = "Have infra-reviewer review the current infra/ changes";
const SRC_REDIRECT = "Have plan-reviewer review the current plan before editing src/";
const DEPLOY_REDIRECT = "Have deploy-reviewer review deploy.sh";
const CONFIG = `import { contribution, corePack, defineConfig } from "bounded/domain";
import { prereqs } from "bounded/prereqs";
export default defineConfig({
  packs: [corePack, prereqs],
  contributes: [
    contribution(prereqs.points.rules, [
      { before: { execute: "terraform apply" }, require: { delegate: "infra-reviewer", succeeded: true }, unchangedSince: ["infra/**"], redirect: "${APPLY_REDIRECT}" },
      { before: { write: "src/**" }, require: { delegate: "plan-reviewer", succeeded: true }, unchangedSince: [".agent-state/*/plan.md"], redirect: "${SRC_REDIRECT}" },
      { before: { execute: "deploy.sh" }, require: { delegate: "deploy-reviewer", succeeded: true }, unchangedSince: ["deploy.sh"], redirect: "${DEPLOY_REDIRECT}" },
    ]),
  ],
});
`;

/** A git project with the rules above, infra/, src/, a plan and deploy.sh, resolving bounded as an installed project would. */
function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-prereqs-shell-")));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
  mkdirSync(join(root, ".agent-state", "item"), { recursive: true });
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "infra"));
  writeFileSync(join(root, ".agent-state", "item", "plan.md"), "the plan\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "infra", "main.tf"), "terraform {}\n");
  writeFileSync(join(root, "deploy.sh"), "#!/bin/sh\necho deploying\n");
  writeFileSync(join(root, "README"), "a project\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.bounded/\n.agent-state/\n");
  writeFileSync(join(root, "bounded.config.ts"), CONFIG);
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

/** The project opened as a host opens it, with a shell call judged from its reading and a delegation run to its end. */
async function opened() {
  const root = project();
  const { judge, afterTool, problem } = await openProject(root, { ports: [...protectedPathsPortProvisions(), ...prereqsPortProvisions()] });
  expect(problem).toBeNull();
  let calls = 0;
  const shell = async (command: string) => {
    const reading = await shellCommandReading.read({ projectRoot: root, command, cwd: null });
    return judge({ kind: "tool-use", role: null, tool: "shell", effects: [{ kind: "execute", command, cwd: null, reading }], callId: `call-${++calls}` });
  };
  /** A delegation to `agent` that ran to its end and succeeded, with the agent the host resolved. */
  const reviewedBy = async (agent: string) => {
    const call = { kind: "tool-use", role: null, tool: "subagent", effects: [{ kind: "delegate", agent }], callId: `review-${++calls}` } as const;
    expect((await judge(call)).kind).toBe("allow");
    expect((await afterTool({ ...call, kind: "tool-result", ok: true, delegatedAgentRuns: [{ finished: true, resolvedAgent: agent }] })).message).toBeNull();
  };
  const reviewedByAll = async () => {
    for (const agent of ["infra-reviewer", "plan-reviewer", "deploy-reviewer"]) await reviewedBy(agent);
  };
  return { shell, reviewedBy, reviewedByAll };
}

const reasonOf = (verdict: { kind: string; reason?: string }): string => (verdict.kind === "refuse" ? (verdict.reason ?? "") : "allowed");
const redirectOf = (verdict: { kind: string; redirect?: string }): string => (verdict.kind === "refuse" ? (verdict.redirect ?? "") : "allowed");

describe("bounded/prereqs judging shell commands from bounded's reading of them", () => {
  test("a Bash terraform apply is refused until infra-reviewer has reviewed infra/, then allowed; terraform plan is always allowed", async () => {
    const { shell, reviewedBy } = await opened();
    expect(reasonOf(await shell("terraform plan"))).toBe("allowed");
    const refused = await shell("terraform apply");
    expect(reasonOf(refused)).toContain("before executing 'terraform apply'");
    expect(reasonOf(refused)).toContain("This call would execute `terraform apply`, which runs 'terraform apply'");
    expect(redirectOf(refused)).toBe(APPLY_REDIRECT);
    await reviewedBy("infra-reviewer");
    expect(reasonOf(await shell("terraform apply"))).toBe("allowed");
    expect(reasonOf(await shell("terraform plan"))).toBe("allowed");
  });

  test("wrapped, nested and option-led forms are refused too", async () => {
    const { shell } = await opened();
    for (const command of [
      "sudo terraform apply",
      "env TF_LOG=1 terraform apply",
      "timeout 600 terraform apply",
      "bash -c 'terraform apply'",
      "find . -maxdepth 0 -exec terraform apply \\;",
      "terraform -chdir=infra apply",
      "cd infra && terraform apply",
    ]) {
      const verdict = await shell(command);
      expect({ command, runs: reasonOf(verdict).includes("which runs 'terraform apply'"), redirect: redirectOf(verdict) }).toEqual({ command, runs: true, redirect: APPLY_REDIRECT });
    }
  });

  test("a shell write under src/ is refused by the write rule", async () => {
    const { shell } = await opened();
    for (const command of ["echo x > src/a.ts", "cp README src/b.ts", "rm src/a.ts", "echo x | tee src/a.ts", "mkdir src/new"]) {
      const verdict = await shell(command);
      expect({ command, writes: reasonOf(verdict).includes("which writes 'src/"), redirect: redirectOf(verdict) }).toEqual({ command, writes: true, redirect: SRC_REDIRECT });
    }
    for (const command of ["echo x > docs.md", "ls src 2>/dev/null"]) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
  });

  test("what bounded cannot see is refused while a rule does not hold, and allowed once it holds", async () => {
    const { shell, reviewedByAll } = await opened();
    const commands = ["$TF apply", "echo apply | xargs terraform", "eval terraform apply", "python3 -c 'import os'", 'echo x > "$OUT"', "echo x > /tmp/out", "terraform -$X", "terraform -$(echo x apply)"];
    for (const command of commands) expect({ command, cannotSee: reasonOf(await shell(command)).includes("bounded cannot see whether it") }).toEqual({ command, cannotSee: true });
    await reviewedByAll();
    for (const command of commands) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
  });

  test("forms whose listing hid what runs are refused as cannot see", async () => {
    const { shell } = await opened();
    for (const command of ["echo apply | xargs -I{} terraform {}", "echo 'terraform apply' | sh", "bash <<EOF\nterraform apply\nEOF", "find . -exec terraform {} \\;"]) {
      expect({ command, cannotSee: reasonOf(await shell(command)).includes("bounded cannot see whether it runs 'terraform apply'") }).toEqual({ command, cannotSee: true });
    }
  });

  test("a run that passes terraform as an argument is refused while the rule does not hold: as running it where the reader now sees the run, as cannot see elsewhere", async () => {
    const { shell, reviewedByAll } = await opened();
    // The reader now reads programs named by their path, trap's code and package runners (ADR 2026-020, amended by shell-reader-coverage).
    const runs = ["/usr/bin/env terraform apply", "/bin/bash -c 'terraform apply'", "trap 'terraform apply' EXIT", "npx terraform apply"];
    for (const command of runs) {
      const verdict = await shell(command);
      expect({ command, runs: reasonOf(verdict).includes("which runs 'terraform apply'"), redirect: redirectOf(verdict) }).toEqual({ command, runs: true, redirect: APPLY_REDIRECT });
    }
    const stdin = await shell("echo 'terraform apply' | bash -");
    expect(reasonOf(stdin)).toContain("bounded cannot see whether it runs 'terraform apply': it runs code bounded cannot read ('(standard input)')");
    expect(redirectOf(stdin)).toBe(APPLY_REDIRECT);
    const cannotSee = [
      "aws-vault exec prof -- terraform apply",
      "op run -- terraform apply",
      "watch terraform apply",
      "ssh host terraform apply",
      "fish -c 'terraform apply'",
      // The over-refusal, stated: a run naming terraform may run it.
      "echo terraform",
      'git commit -m "bump terraform"',
    ];
    for (const command of cannotSee) {
      const verdict = await shell(command);
      expect({ command, cannotSee: reasonOf(verdict).includes("bounded cannot see whether it runs 'terraform apply'"), redirect: redirectOf(verdict) }).toEqual({ command, cannotSee: true, redirect: APPLY_REDIRECT });
    }
    await reviewedByAll();
    for (const command of [...runs, "echo 'terraform apply' | bash -", ...cannotSee]) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
  });

  test("terraform passed inside an argument is found past quotes, separators and unresolved words; a shell named by its path, time and coproc are seen to run it", async () => {
    const { shell, reviewedByAll } = await opened();
    const passed = ["ssh host 'cd infra&&terraform apply'", 'watch "terraform apply $FLAGS"', '/bin/sh -c "terraform apply $X"'];
    const ran = ["/bin/bash -c 'cd infra;terraform apply'", "/bin/sh -c '\"terraform\" apply'", "time terraform apply", "coproc terraform apply"];
    for (const command of [...passed, ...ran]) {
      const verdict = await shell(command);
      expect({ command, refused: reasonOf(verdict).includes("terraform apply"), redirect: redirectOf(verdict) }).toEqual({ command, refused: true, redirect: APPLY_REDIRECT });
    }
    for (const command of passed) expect({ command, cannotSee: reasonOf(await shell(command)).includes("bounded cannot see whether it runs 'terraform apply'") }).toEqual({ command, cannotSee: true });
    // A shell found by its path, time and coproc are read as the commands they are (ADR 2026-020, amended by shell-reader-coverage).
    for (const command of ran) expect({ command, runs: reasonOf(await shell(command)).includes("which runs 'terraform apply'") }).toEqual({ command, runs: true });
    await reviewedByAll();
    for (const command of [...passed, ...ran]) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
  });

  test("a shell reading its code from standard input through -, /dev/stdin or /dev/fd/N is refused as cannot see (final review)", async () => {
    const { shell } = await opened();
    for (const command of [
      "bash - <<< 'terraform apply'",
      "bash /dev/stdin <<< 'terraform apply'",
      "sh /dev/fd/0 <<< 'terraform apply'",
      "bash - <<'EOF'\nterraform apply\nEOF",
      // The fourth final review's: options walked as getopt walks them, and every spelling of standard input.
      "bash -euo pipefail <<< 'terraform apply'",
      "bash -eo pipefail <<'EOF'\nterraform apply\nEOF",
      "bash --rcfile /dev/null <<< 'terraform apply'",
      "bash --init-file x <<< 'terraform apply'",
      "bash -es x <<< 'terraform apply'",
      "bash /proc/self/fd/0 <<< 'terraform apply'",
      "bash //dev/stdin <<< 'terraform apply'",
      "bash /dev/./stdin <<< 'terraform apply'",
      // The fifth final review's: o and O read every way the shells read them (recorded), and standard input failing closed.
      "zsh -Os x <<< 'terraform apply'",
      "bash -oe pipefail <<< 'terraform apply'",
      "bash -oo errexit pipefail <<< 'terraform apply'",
      "bash -os pipefail <<< 'terraform apply'",
      "sh -oe errexit <<< 'terraform apply'",
      "bash /dev/../dev/stdin <<< 'terraform apply'",
      "bash ../../../../../../../../../../dev/stdin <<< 'terraform apply'",
      "bash /proc/self/fd/3 3<<< 'terraform apply'",
      "bash /proc/thread-self/fd/0 <<< 'terraform apply'",
    ]) {
      const verdict = await shell(command);
      expect({ command, cannotSee: reasonOf(verdict).includes("bounded cannot see whether it runs 'terraform apply': it runs code bounded cannot read ('(standard input)')"), redirect: redirectOf(verdict) }).toEqual({
        command,
        cannotSee: true,
        redirect: APPLY_REDIRECT,
      });
    }
    // Code a shell runs in some shell's reading of its options: parsed and walked, so its unresolved program name is seen.
    for (const command of ["zsh -Oc 'terra$()form apply'", "bash -oc posix 'terra$()form apply'"]) {
      const verdict = await shell(command);
      expect({ command, cannotSee: reasonOf(verdict).includes("bounded cannot see whether it runs 'terraform apply': it runs a program whose name only the shell can resolve"), redirect: redirectOf(verdict) }).toEqual({
        command,
        cannotSee: true,
        redirect: `${APPLY_REDIRECT} (or, if this command does not run 'terraform apply', write it so that bounded can read it: no words only the shell can resolve where a program, its leading arguments or a written path stand)`,
      });
    }
  });

  test("programs the reader does not interpret take what it cannot see as code; sudo and doas shells, sourced files and trap's code are code: refused while a rule does not hold, under execute and write rules", async () => {
    const { shell, reviewedBy, reviewedByAll } = await opened();
    /** The cannot-see part of a refusal: what follows "cannot see whether it …: ". */
    const cannotSeeOf = (verdict: { kind: string; reason?: string }): string => {
      const reason = reasonOf(verdict);
      const at = reason.indexOf("bounded cannot see whether it ");
      if (at === -1) return reason;
      const rest = reason.slice(at);
      return rest.slice(rest.indexOf(": ") + 2);
    };
    const code = (word: string) => `it runs code bounded cannot read ('${word}')`;
    const name = (word: string) => `it runs a program whose name only the shell can resolve ('${word}')`;
    const STANDARD_INPUT = code("(standard input)");
    const forms: readonly (readonly [string, string])[] = [
      ['ssh host "terra$()form apply"', code('"terra$()form apply"')],
      ['watch "terra$()form apply"', code('"terra$()form apply"')],
      ['su -c "terra$()form apply"', code('"terra$()form apply"')],
      ['script -c "terra$()form apply"', code('"terra$()form apply"')],
      // prereqs-execute's limit case's forms, each now refused.
      ["/bin/bash -c 'terra$()form apply'", name("terra$()form")],
      ["su -c $'\\x74erraform apply'", code("$'\\x74erraform apply'")],
      ['script -c "$(echo dGVycmFmb3JtIGFwcGx5 | base64 -d)"', code('"$(echo dGVycmFmb3JtIGFwcGx5 | base64 -d)"')],
      ["time $TF apply", name("$TF")],
      ["coproc $TF apply", name("$TF")],
      ['/usr/bin/env "$TF" apply', name('"$TF"')],
      ["/bin/sh <<< 'terraform apply'", STANDARD_INPUT],
      ["sudo -s <<< 'terraform apply'", STANDARD_INPUT],
      ["sudo -i <<< 'terraform apply'", STANDARD_INPUT],
      ["doas -s <<< 'terraform apply'", STANDARD_INPUT],
      ["source /dev/stdin <<< 'terraform apply'", code("/dev/stdin")],
      [". /dev/stdin <<< 'terraform apply'", code("/dev/stdin")],
      ["trap 'terra$()form apply' EXIT", name("terra$()form")],
      // The over-refusal, stated: a program the table does not know, given a word only the shell can resolve or piped input.
      ['mytool "$X"', code('"$X"')],
      ["cat a | mytool", code("(piped input)")],
    ];
    for (const [command, part] of forms) expect({ command, part: cannotSeeOf(await shell(command)) }).toEqual({ command, part });
    // xargs's input reaches the command env runs: what it names only the run can tell.
    for (const command of ["base64 -d <<< 'dGVycmFmb3JtIGFwcGx5' | xargs /usr/bin/env", "cat commands.txt | xargs /usr/bin/env"]) {
      expect({ command, part: cannotSeeOf(await shell(command)).endsWith("('(input)')") }).toEqual({ command, part: true });
    }
    // Under the write rule before src/**, once the execute rule holds: each refused as cannot see.
    await reviewedBy("infra-reviewer");
    for (const [command] of forms) expect({ command, cannotSee: reasonOf(await shell(command)).includes("bounded cannot see whether it writes a path 'src/**' matches") }).toEqual({ command, cannotSee: true });
    await reviewedByAll();
    for (const [command] of forms) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
  });

  test("a literal argument holding shell syntax, given to a program the reader does not interpret, is code: refused while a rule does not hold; known programs keep their reads", async () => {
    const { shell, reviewedByAll } = await opened();
    const code = (word: string) => `bounded cannot see whether it runs 'terraform apply': it runs code bounded cannot read ('${word}')`;
    const refused: readonly (readonly [string, string])[] = [
      // ssh, watch and their kind run a literal argument as shell code (ADR 2026-020, amended by shell-reader-coverage).
      ["ssh host 'terra``form apply'", "terra``form apply"],
      ["watch 'terra$" + "{x}form apply'", "terra$" + "{x}form apply"],
      ["ssh host 'cd infra && terraform apply'", "cd infra && terraform apply"],
      ["watch 'a; b'", "a; b"],
      ["ssh host 'a | b'", "a | b"],
      ["ssh host 'a || b'", "a || b"],
      // A refusal's text has its line breaks made spaces.
      ["ssh host $'a\\nb'", "a b"],
      // The over-refusal, stated: a literal '$' given to a program the table does not know.
      ["mytool '$HOME'", "$HOME"],
    ];
    for (const [command, word] of refused) expect({ command, code: reasonOf(await shell(command)).includes(code(word)) }).toEqual({ command, code: true });
    // Known programs keep their reads; a literal with no shell syntax stays a read.
    for (const command of ["grep '$x' README", "echo '$HOME'", "mytool 'plain words'", "printf '%s;' a"]) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
    await reviewedByAll();
    for (const [command] of refused) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
  });

  test("limit: a script run through a shell is not seen to run; a sourced one is code bounded cannot read", async () => {
    const { shell } = await opened();
    const direct = await shell("./deploy.sh");
    expect(reasonOf(direct)).toContain("which runs 'deploy.sh'");
    expect(redirectOf(direct)).toBe(DEPLOY_REDIRECT);
    const run = reasonOf(await shell("bash deploy.sh"));
    expect({ cannotSee: run.includes("bounded cannot see whether it runs 'deploy.sh'"), runs: run.includes("which runs 'deploy.sh'") }).toEqual({ cannotSee: true, runs: false });
    for (const command of [". deploy.sh", "source deploy.sh"]) {
      const reason = reasonOf(await shell(command));
      expect({ command, code: reason.includes("it runs code bounded cannot read ('deploy.sh')"), runs: reason.includes("which runs 'deploy.sh'") }).toEqual({ command, code: true, runs: false });
    }
  });
});

describe("bounded/prereqs judging shell commands from bounded's reading of them — every reading adds (ADR 2026-020, amended by shell-every-reading)", () => {
  /** The cannot-see part of a refusal: what follows "cannot see whether it …: ". */
  const cannotSeeOf = (verdict: { kind: string; reason?: string }): string => {
    const reason = reasonOf(verdict);
    const at = reason.indexOf("bounded cannot see whether it ");
    if (at === -1) return reason;
    const rest = reason.slice(at);
    return rest.slice(rest.indexOf(": ") + 2);
  };

  test("a write into a directory only the shell can name, or from a source only the shell can name, is refused while a write rule does not hold", async () => {
    const { shell } = await opened();
    for (const [command, part] of [
      ['cp -t "$D" src/a.ts', `it writes a path only the shell can resolve ('"$D"')`],
      ['cp "$X" src/', `it writes a path only the shell can resolve ('src/"$X"')`],
      // A move deletes its source, wherever it goes: reported first, then the write into src/.
      ['mv "$X" src/', `it writes a path only the shell can resolve ('"$X"')`],
      ["ls | xargs cp -t src", "it writes a path only the shell can resolve ('src/(input)')"],
      ['mv "$F" notes.txt', `it writes a path only the shell can resolve ('"$F"')`],
    ] as const) {
      const verdict = await shell(command);
      expect({ command, part: cannotSeeOf(verdict), redirect: redirectOf(verdict).startsWith(SRC_REDIRECT) }).toEqual({ command, part, redirect: true });
    }
  });

  test("a plus-signed range's words are judged", async () => {
    const { shell } = await opened();
    expect(reasonOf(await shell("rm src/a{+1..2}.ts"))).toContain("which writes 'src/");
  });

  test("forms with an unresolved program name or unseen code are refused while a rule does not hold", async () => {
    const { shell, reviewedBy, reviewedByAll } = await opened();
    const name = (word: string) => `it runs a program whose name only the shell can resolve ('${word}')`;
    const STANDARD_INPUT = "it runs code bounded cannot read ('(standard input)')";
    // Under the execute rule before terraform apply, the first: a program name only the shell can resolve is found before code.
    const beforeApply = [
      ['exec "$@"', name('"$@"')],
      ['sudo "$@"', name('"$@"')],
      ['bash "$SCRIPT"', STANDARD_INPUT],
      ['"$CMD" --version', name('"$CMD"')],
      ['env "$VAR=1" node app.js', name('"$VAR=1"')],
    ] as const;
    for (const [command, part] of beforeApply) expect({ command, part: cannotSeeOf(await shell(command)) }).toEqual({ command, part });
    // Under the write rule before src/**, once the first holds: code is found before a program's name.
    await reviewedBy("infra-reviewer");
    const beforeSrc = [
      ['exec "$@"', STANDARD_INPUT],
      ['sudo "$@"', STANDARD_INPUT],
      ['bash "$SCRIPT"', STANDARD_INPUT],
      ['"$CMD" --version', STANDARD_INPUT],
      ['env "$VAR=1" node app.js', name('"$VAR=1"')],
    ] as const;
    for (const [command, part] of beforeSrc) expect({ command, part: cannotSeeOf(await shell(command)) }).toEqual({ command, part });
    await reviewedByAll();
    for (const [command] of beforeSrc) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
  });

  test("a cd the reading cannot place is refused while a rule does not hold", async () => {
    const { shell, reviewedBy } = await opened();
    await reviewedBy("infra-reviewer");
    // "$W" may be builtin, so the shell may delete sub/x: bounded cannot place that cd, and refuses while a rule does not hold.
    expect(cannotSeeOf(await shell('"$W" cd sub && rm x'))).toBe(`it runs a program whose name only the shell can resolve ('"$W"')`);
  });

  test("a shell whose options only the shell can resolve may read standard input", async () => {
    const { shell } = await opened();
    expect(cannotSeeOf(await shell(`echo 'terraform apply' | bash "$X" deploy.sh`))).toBe("it runs code bounded cannot read ('(standard input)')");
  });

  test("a shell whose options only the shell can resolve may read its operand as code", async () => {
    const { shell } = await opened();
    expect(cannotSeeOf(await shell('bash "$S" "$1"'))).toBe(`it runs code bounded cannot read ('"$1"')`);
  });
});

describe("bounded/prereqs judging shell commands from bounded's reading of them — the reader's new readings (ADR 2026-020, amended by shell-reader-coverage)", () => {
  /** The cannot-see part of a refusal: what follows "cannot see whether it …: ". */
  const cannotSeeOf = (verdict: { kind: string; reason?: string }): string => {
    const reason = reasonOf(verdict);
    const at = reason.indexOf("bounded cannot see whether it ");
    if (at === -1) return reason;
    const rest = reason.slice(at);
    return rest.slice(rest.indexOf(": ") + 2);
  };
  const code = (word: string) => `it runs code bounded cannot read ('${word}')`;
  const write = (word: string) => `it writes a path only the shell can resolve ('${word}')`;
  const WORKING_TREE = write("(the working tree)");

  test("forms that give only an unresolved write or code are refused while a write rule does not hold", async () => {
    const { shell } = await opened();
    for (const [command, part] of [
      ["git stash pop", WORKING_TREE],
      ["git checkout main", WORKING_TREE],
      ["git switch main", WORKING_TREE],
      ["git reset --hard", WORKING_TREE],
      ["git apply p.patch", WORKING_TREE],
      ["git checkout -- .", WORKING_TREE],
      ["git restore :/src", WORKING_TREE],
      ["git stash push -- src", WORKING_TREE],
      ["git checkout -f main", WORKING_TREE],
      ["git switch --discard-changes main", WORKING_TREE],
      ["sudo -s", code("(standard input)")],
      ["doas -s", code("(standard input)")],
      ["coproc NAME { true; }", code("(coproc's { … } body)")],
      ["time cd src; rm a.ts", code("(where time's command moves the shell)")],
      [". ./env.sh", code("./env.sh")],
      ["alias c='rm src/a.ts'", code("rm src/a.ts")],
      ["pnpm -r exec rm src/a.ts", write("src/a.ts")],
      ["find src -execdir rm a.ts \\;", write("a.ts")],
      ["trap 'rm a.ts' EXIT; cd src", write("a.ts")],
      // Pins: refused already, through prereqs-execute.
      ["bash -", code("(standard input)")],
      ["bash -xs", code("(standard input)")],
    ] as const) {
      expect({ command, part: cannotSeeOf(await shell(command)) }).toEqual({ command, part });
    }
    // A glob pathspec is also the literal path it spells, which the rule matches: refused for that write.
    expect(reasonOf(await shell("git restore 'src/*'"))).toContain("which writes 'src/*'");
  });

  test("writes the new readings make under src/ are refused as definite", async () => {
    const { shell } = await opened();
    for (const command of [
      "/bin/rm src/a.ts",
      "time rm src/a.ts",
      "trap 'rm src/a.ts' EXIT",
      "git checkout -- src/a.ts",
      "git restore src/a.ts",
      "pnpm exec rm src/a.ts",
      "coproc rm src/a.ts",
      "coproc (rm src/a.ts)",
      "sort -o src/a.ts in.txt",
      "yq -i '.a=1' src/c.yaml",
    ]) {
      const verdict = await shell(command);
      expect({ command, writes: reasonOf(verdict).includes("which writes 'src/"), redirect: redirectOf(verdict) }).toEqual({ command, writes: true, redirect: SRC_REDIRECT });
    }
  });

  test("xargs's input reaches a program named by its path", async () => {
    const { shell } = await opened();
    expect(cannotSeeOf(await shell("ls src | xargs /bin/rm"))).toBe(write("(input)"));
  });

  test("the common text programs are read and allowed under an unmet rule", async () => {
    const { shell } = await opened();
    for (const command of ["cat a | grep x", "jq . f.json", "git log | head", "sort -o out.txt in.txt", 'echo "$HOME"', 'cat "$F"', "cat README | sort | uniq -c | head -n 3"]) {
      expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
    }
    // sort -o writes its file.
    expect(reasonOf(await shell("sort -o src/a.ts README"))).toContain("which writes 'src/a.ts'");
  });
});
