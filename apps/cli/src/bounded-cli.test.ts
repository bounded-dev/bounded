import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INITIAL_CONFIG } from "./initial-config.ts";
import { runBoundedCli } from "./bounded-cli.ts";

// A host installer that writes fake-hook.json once and reports it; afterwards it changes nothing.
const FAKE_INSTALLER = `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const hostInstaller = {
  host: "fake",
  install: async (root) => {
    const path = join(root, "fake-hook.json");
    if (existsSync(path)) return { ok: true, value: { host: "fake", changedPaths: [], skippedBecause: null } };
    writeFileSync(path, "{}\\n");
    return { ok: true, value: { host: "fake", changedPaths: ["fake-hook.json"], skippedBecause: null } };
  },
};
`;

/** A project depending on a fake host adapter package, installed under its node_modules. */
function project(files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cli-")));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", dependencies: { "fake-host": "1.0.0" } }));
  const fake = join(root, "node_modules", "fake-host");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "fake-host", type: "module", exports: { "./host-installer": "./host-installer.js" } }));
  writeFileSync(join(fake, "host-installer.js"), FAKE_INSTALLER);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

describe("bounded-cli: the bounded command, in its own app", () => {
  test("init --no-install in a fresh project writes the configuration, runs the host installers and says to restart the host session", async () => {
    const root = project();
    const ran = await runBoundedCli(["init", "--no-install"], root);
    expect(ran.exitCode).toBe(0);
    expect(readFileSync(join(root, "bounded.config.ts"), "utf8")).toBe(INITIAL_CONFIG);
    expect(existsSync(join(root, "fake-hook.json"))).toBe(true);
    expect(ran.stdout).toContain("bounded.config.ts");
    expect(ran.stdout).toContain("fake");
    expect(ran.stdout).toMatch(/restart/i);
  });

  test("init's report and the usage name the protected-paths pack, and the report does not miscount its default rules", async () => {
    const formerName = new RegExp(["path", "gate"].join("[-\\s_]?"), "i");
    const ran = await runBoundedCli(["init", "--no-install"], project());
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("it selects the protected-paths pack, which brings in the core");
    expect(ran.stdout).not.toContain("two default rules");
    expect(ran.stdout).not.toMatch(formerName);
    const usage = await runBoundedCli([], project());
    expect(usage.stderr).toContain("the protected-paths pack");
    expect(usage.stderr).not.toMatch(formerName);
  });

  test("init refuses a project that already has a configuration, changing nothing", async () => {
    const root = project({ "bounded.config.js": "export default 1;\n" });
    const ran = await runBoundedCli(["init"], root);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain("bounded update");
    expect(readFileSync(join(root, "bounded.config.js"), "utf8")).toBe("export default 1;\n");
    expect(existsSync(join(root, "bounded.config.ts"))).toBe(false);
    expect(existsSync(join(root, "fake-hook.json"))).toBe(false);
  });

  test("update --no-upgrade refreshes the hooks, is idempotent, and never touches the configuration", async () => {
    const root = project({ "bounded.config.ts": "// mine\n" });
    const first = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(root, "fake-hook.json"))).toBe(true);
    expect(first.stdout).toMatch(/restart/i);
    const second = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("up to date");
    expect(readFileSync(join(root, "bounded.config.ts"), "utf8")).toBe("// mine\n");
  });

  test("update refuses a project that was never initialised, saying to run bounded init", async () => {
    const root = project();
    for (const args of [["update"], ["update", "--no-upgrade"]]) {
      const ran = await runBoundedCli(args, root);
      expect(ran.exitCode).toBe(1);
      expect(ran.stderr).toContain("bounded init");
      expect(existsSync(join(root, "fake-hook.json"))).toBe(false);
    }
  });

  test("an unknown command, or none, prints the usage and exits 2", async () => {
    for (const args of [[], ["frobnicate"], ["update", "--sideways"]]) {
      const ran = await runBoundedCli(args, project());
      expect(ran.exitCode).toBe(2);
      expect(ran.stderr).toContain("bounded init");
      expect(ran.stderr).toContain("bounded update");
    }
  });
});
