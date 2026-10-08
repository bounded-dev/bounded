// The pi host as bounded ships it: dist/hosts/pi/index.js, built by bounded's
// prepack (the test run builds dist first), loaded by node with a fake pi.
// Its shell commands are read by bounded/shell-command-reader, the reader
// built into dist (ADR 2026-020), not a copy inlined into the host.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CORE = resolve(import.meta.dir, "../../../contexts/core");
/** A configuration keeping agents off git's hooks, as the one `bounded init` writes does. */
const CONFIG = `import { contribution, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";
export default defineConfig({
  packs: [pathGate],
  contributes: [
    contribution(pathGate.points.protectedPaths, [
      { match: ".git/hooks/**", deny: ["create", "modify", "delete"], why: "git runs these hooks later, outside Bounded's view", redirect: "Ask a person to add or change git hooks; describe the check you need" },
    ]),
  ],
});
`;

/** What pi's tool_call handler answers for a `bash` call running `command`, in a session of the built host under node. */
function bashUnderNode(root: string, command: string): unknown {
  const script = `const { bounded } = await import("bounded/hosts/pi");
const handlers = {};
bounded(process.argv[1])({ on(event, handler) { handlers[event] = handler; } });
await handlers.session_start({ type: "session_start", reason: "startup" }, { cwd: process.argv[1] });
const result = await handlers.tool_call({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: process.argv[2] } }, { cwd: process.argv[1] });
console.log(JSON.stringify(result ?? null));`;
  const ran = Bun.spawnSync(["node", "--input-type=module", "-e", script, root, command], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return JSON.parse(ran.stdout.toString().trim().split("\n").at(-1) ?? "null");
}

describe("the built pi host under node", () => {
  test("reads a bash command with the bundled reader and blocks a write to git's hooks, naming the rule", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-bundle-")));
    mkdirSync(join(root, "node_modules"));
    symlinkSync(CORE, join(root, "node_modules", "bounded"), "dir");
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, "bounded.config.ts"), CONFIG);
    const blocked = bashUnderNode(root, "echo x > .git/hooks/pre-commit");
    expect(blocked).toMatchObject({ block: true });
    expect((blocked as { reason: string }).reason).toContain("the rule '.git/hooks/**' from bounded/project denies create of '.git/hooks/pre-commit'");
    expect(bashUnderNode(root, "echo x > notes.txt")).toBeNull();
  }, 60_000);
});
