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

  test("a run that passes terraform as an argument is refused while the rule does not hold, as cannot see", async () => {
    const { shell, reviewedByAll } = await opened();
    const commands = [
      "/usr/bin/env terraform apply",
      "/bin/bash -c 'terraform apply'",
      "echo 'terraform apply' | bash -",
      "trap 'terraform apply' EXIT",
      "aws-vault exec prof -- terraform apply",
      "op run -- terraform apply",
      "watch terraform apply",
      "ssh host terraform apply",
      "fish -c 'terraform apply'",
      "npx terraform apply",
      // The over-refusal, stated: a run naming terraform may run it.
      "echo terraform",
      'git commit -m "bump terraform"',
    ];
    for (const command of commands) {
      const verdict = await shell(command);
      expect({ command, cannotSee: reasonOf(verdict).includes("bounded cannot see whether it runs 'terraform apply'"), redirect: redirectOf(verdict) }).toEqual({ command, cannotSee: true, redirect: APPLY_REDIRECT });
    }
    await reviewedByAll();
    for (const command of commands) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
  });

  test("terraform passed inside an argument is found past quotes, separators and unresolved words (final review, B1)", async () => {
    const { shell, reviewedByAll } = await opened();
    const commands = [
      "/bin/bash -c 'cd infra;terraform apply'",
      "/bin/sh -c '\"terraform\" apply'",
      "ssh host 'cd infra&&terraform apply'",
      'watch "terraform apply $FLAGS"',
      '/bin/sh -c "terraform apply $X"',
      "time terraform apply",
      "coproc terraform apply",
    ];
    for (const command of commands) {
      const verdict = await shell(command);
      expect({ command, refused: reasonOf(verdict).includes("terraform apply"), redirect: redirectOf(verdict) }).toEqual({ command, refused: true, redirect: APPLY_REDIRECT });
    }
    // tree-sitter reads time and coproc as programs named so, given terraform as an argument: cannot see.
    for (const command of commands) expect({ command, cannotSee: reasonOf(await shell(command)).includes("bounded cannot see whether it runs 'terraform apply'") }).toEqual({ command, cannotSee: true });
    await reviewedByAll();
    for (const command of commands) expect({ command, verdict: reasonOf(await shell(command)) }).toEqual({ command, verdict: "allowed" });
  });

  test("limit: a script run through a shell, or sourced, is not seen to run; it is refused only because its name stands as an argument", async () => {
    const { shell } = await opened();
    const direct = await shell("./deploy.sh");
    expect(reasonOf(direct)).toContain("which runs 'deploy.sh'");
    expect(redirectOf(direct)).toBe(DEPLOY_REDIRECT);
    for (const command of ["bash deploy.sh", ". deploy.sh", "source deploy.sh"]) {
      const reason = reasonOf(await shell(command));
      expect({ command, cannotSee: reason.includes("bounded cannot see whether it runs 'deploy.sh'"), runs: reason.includes("which runs 'deploy.sh'") }).toEqual({ command, cannotSee: true, runs: false });
    }
  });
});
