// Which host installers run: bounded bundles one per host at
// ./hosts/<host>/host-installer, and runs only those of the hosts named with
// --host, or found by their directory (.claude/, .pi/); an installer another
// package offers at ./host-installer always runs, since installing that
// package chose it.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedCli } from "./bounded-cli.ts";

/** An installer for `host` that writes `<host>.installed` in the project and reports it. */
const installer = (host: string) => `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export const hostInstaller = {
  host: "${host}",
  install: async (root) => {
    writeFileSync(join(root, "${host}.installed"), "");
    return { ok: true, value: { host: "${host}", changedPaths: ["${host}.installed"], skippedBecause: null } };
  },
};
`;

/** A project with a stand-in bounded bundling installers for claude-code and pi, a third-party host adapter, and the given directories. */
function project(dirs: readonly string[], files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-cli-hosts-")));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", devDependencies: { bounded: "3.0.0", "third-party": "1.0.0" } }));
  const bounded = join(root, "node_modules", "bounded");
  mkdirSync(bounded, { recursive: true });
  writeFileSync(
    join(bounded, "package.json"),
    JSON.stringify({ name: "bounded", version: "3.0.0", type: "module", exports: { "./domain": "./domain.js", "./hosts/claude-code/host-installer": "./claude-code.js", "./hosts/pi/host-installer": "./pi.js" } }),
  );
  writeFileSync(join(bounded, "claude-code.js"), installer("claude-code"));
  writeFileSync(join(bounded, "pi.js"), installer("pi"));
  const third = join(root, "node_modules", "third-party");
  mkdirSync(third, { recursive: true });
  writeFileSync(join(third, "package.json"), JSON.stringify({ name: "third-party", version: "1.0.0", type: "module", exports: { "./host-installer": "./host-installer.js" } }));
  writeFileSync(join(third, "host-installer.js"), installer("third"));
  for (const dir of dirs) mkdirSync(join(root, dir));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const ran = (root: string): string[] => ["claude-code", "pi", "third"].filter((host) => existsSync(join(root, `${host}.installed`)));

describe("bounded's bundled host installers: only the hosts named or found", () => {
  test("init --no-install --host runs the bundled installers of the hosts named, and every other package's installer", async () => {
    const root = project([".claude", ".pi"]);
    const done = await runBoundedCli(["init", "--no-install", "--host", "pi"], root);
    expect(done.stderr).toBe("");
    expect(done.exitCode).toBe(0);
    expect(ran(root)).toEqual(["pi", "third"]);
  });

  test("init --no-install with no host named runs the bundled installers of the hosts found by their directory", async () => {
    const root = project([".claude"]);
    const done = await runBoundedCli(["init", "--no-install"], root);
    expect(done.exitCode).toBe(0);
    expect(ran(root)).toEqual(["claude-code", "third"]);
  });

  test("update --no-upgrade refreshes the bundled hosts found by their directory, and every other package's installer", async () => {
    const root = project([".pi"], { "bounded.config.ts": "// mine\n" });
    const done = await runBoundedCli(["update", "--no-upgrade"], root);
    expect(done.exitCode).toBe(0);
    expect(ran(root)).toEqual(["pi", "third"]);
  });

  test("refuses a host name that is not one", async () => {
    const root = project([]);
    const done = await runBoundedCli(["init", "--no-install", "--host", "../evil"], root);
    expect(done.exitCode).toBe(1);
    expect(done.stderr).toContain("../evil");
    expect(ran(root)).toEqual([]);
  });
});
