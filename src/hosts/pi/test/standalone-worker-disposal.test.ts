import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Pi worker disposes its selected session snapshot after its input stream closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-pi-disposal-"));
  try {
    mkdirSync(join(root, ".bounded"));
    writeFileSync(join(root, ".bounded", "version.json"), `${JSON.stringify({ schema: "bounded-project-version/1", version: "1.2.3" })}\n`);
    const marker = join(root, "disposed.log");
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "standalone-worker-disposal.ts"), root, "1.2.3", marker],
      { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    worker.stdin.write(`${JSON.stringify({ protocol: 1, id: 1, event: "session_start", payload: { type: "session_start", reason: "startup" }, context: { cwd: root } })}\n`);
    worker.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout.trim())).toMatchObject({ protocol: 1, id: 1, event: "session_start", result: null });
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("disposed\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
