import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostInstallerConformance, snapshotFiles } from "bounded/application/host-installer-conformance";
import { hostInstaller } from "./host-installer.ts";
import { piLoader } from "./install.ts";

const LOADER = piLoader();

hostInstallerConformance("the pi host installer", hostInstaller, async (kind) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-conformance-")));
  mkdirSync(join(root, ".pi"));
  // A directory where the loader belongs: it cannot be read as a file.
  if (kind === "unreadable") mkdirSync(join(root, LOADER.path), { recursive: true });
  return { root, snapshot: () => snapshotFiles(root) };
});

describe("the pi host installer, with a loader it cannot read", () => {
  test("refuses and leaves the loader alone, rather than overwriting it", async () => {
    if (process.getuid?.() === 0) return; // root reads every file
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bounded-pi-conformance-")));
    const path = join(root, LOADER.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "// the project's own loader\n");
    chmodSync(path, 0o000);
    const installed = await hostInstaller.install(root);
    chmodSync(path, 0o600);
    expect(!installed.ok && installed.error.includes("cannot be read")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("// the project's own loader\n");
  });
});
