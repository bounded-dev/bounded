import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runBoundedCli } from "./bounded-cli.ts";

test("the current Node CLI refuses a standalone pinned project before loading host installers", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-node-standalone-guard-"));
  try {
    const marker = join(root, "installer-was-called");
    const host = join(root, "node_modules", "fake-host");
    mkdirSync(host, { recursive: true });
    mkdirSync(join(root, ".bounded"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "project", dependencies: { "fake-host": "1.0.0" } }));
    writeFileSync(join(root, "bounded.config.ts"), "// user configuration\n");
    writeFileSync(join(root, ".bounded", "version.json"), '{"schema":"bounded-project-version/1","version":"3.3.0"}\n');
    writeFileSync(join(host, "package.json"), '{"name":"fake-host","type":"module","exports":{"./host-installer":"./host-installer.js"}}\n');
    writeFileSync(join(host, "host-installer.js"), `import { writeFileSync } from "node:fs";
export const hostInstaller = { host: "fake", install: async () => { writeFileSync(${JSON.stringify(marker)}, "called"); return { ok: true, value: { host: "fake", changedPaths: [], skippedBecause: null } }; } };
`);
    const pin = readFileSync(join(root, ".bounded", "version.json"));
    for (const args of [["update", "--no-upgrade"], ["update"]]) {
      const answer = await runBoundedCli(args, root);
      expect(answer.exitCode).not.toBe(0);
      expect(answer.stderr).toMatch(/standalone|installed executable|bounded update/i);
      expect(readFileSync(join(root, ".bounded", "version.json"))).toEqual(pin);
      expect(existsSync(marker)).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
