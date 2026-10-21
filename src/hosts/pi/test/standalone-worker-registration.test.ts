import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Pi worker refuses a guarded call if its adapter omits tool_call registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-pi-registration-"));
  try {
    mkdirSync(join(root, ".bounded"));
    writeFileSync(join(root, ".bounded", "version.json"), `${JSON.stringify({ schema: "bounded-project-version/1", version: "1.2.3" })}\n`);
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "standalone-worker-missing-registration.ts"), root, "1.2.3"],
      { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const context = { cwd: root };
    worker.stdin.write(`${JSON.stringify({ protocol: 1, id: 1, event: "session_start", payload: { type: "session_start", reason: "startup" }, context })}\n`);
    worker.stdin.write(`${JSON.stringify({ protocol: 1, id: 2, event: "tool_call", payload: { type: "tool_call", toolCallId: "missing-guard", toolName: "read", input: { path: "main.py" } }, context })}\n`);
    worker.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(readFileSync(join(root, "registrations.log"), "utf8")).toBe("mock registered\n");
    const replies = stdout.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result: unknown });
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ id: 1, result: null });
    expect(replies[1]).toMatchObject({ id: 2, result: { block: true } });
    expect(JSON.stringify(replies[1]?.result)).toMatch(/did not register tool_call/);
    expect(existsSync(join(root, ".bounded", "log.jsonl"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
