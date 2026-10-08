// pi discovers global extensions by scanning ~/.pi/agent/extensions/ — direct
// files, or one level of subdirectory carrying a package.json that declares
// `pi.extensions`. It does NOT read the agent dir's own package.json. The
// adapter lives in hosts/pi/extensions/ (ADR 2026-035), so the drop zone
// carries one loader shim (extensions/bounded/package.json) whose manifest is
// the only way any of it loads.
//
// This suite exists because the move to hosts/pi/ shipped green — every unit
// test passed — while a live pi session loaded nothing and ran a whole
// dogfood arm ungated. Discovery is part of the adapter's contract, so it is
// pinned here against pi's documented rules, not against hope.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const AGENT = resolve(import.meta.dirname, "..", "..");
const ADAPTER_DIR = join(AGENT, "hosts", "pi", "extensions");
const SHIM = join(AGENT, "extensions", "bounded", "package.json");

function shimEntries(): readonly string[] {
  const manifest = JSON.parse(readFileSync(SHIM, "utf8")) as {
    pi?: { extensions?: readonly string[] };
  };
  return manifest.pi?.extensions ?? [];
}

describe("the pi adapter is discoverable the way pi actually discovers (ADR 2026-035)", () => {
  test("the loader shim exists where pi's global scan looks", () => {
    expect(existsSync(SHIM)).toBe(true);
  });

  // Regression (Run 28): the hosts/pi restructure left HARNESS_ROOT walking up
  // too few levels, so it pointed at hosts/pi and every architect skill read
  // was refused — a role could not read its own SKILL.md. The root must be the
  // agent dir (the one holding skills/), or isHarnessSkillRead never matches.
  test("the path-gate extension resolves HARNESS_ROOT to the agent dir (skill reads depend on it)", async () => {
    const { HARNESS_ROOT } = (await import("./extensions/path-gate.ts")) as { HARNESS_ROOT: string };
    expect(HARNESS_ROOT).toBe(AGENT);
    expect(existsSync(join(HARNESS_ROOT, "skills")), "root holds skills/").toBe(true);
    expect(existsSync(join(HARNESS_ROOT, "packs")), "root holds packs/").toBe(true);
  });

  test("every shim entry resolves to a real file, rooted in hosts/pi/extensions", () => {
    for (const entry of shimEntries()) {
      const resolved = resolve(dirname(SHIM), entry);
      expect(existsSync(resolved), `${entry} resolves`).toBe(true);
      expect(resolved.startsWith(ADAPTER_DIR), `${entry} lives in the adapter`).toBe(true);
    }
  });

  test("every top-level adapter extension is in the shim — a new file that is not listed does not load", () => {
    const adapterFiles = readdirSync(ADAPTER_DIR)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort();
    const listed = shimEntries()
      .map((entry) => resolve(dirname(SHIM), entry))
      .map((abs) => abs.slice(ADAPTER_DIR.length + 1))
      .sort();
    expect(listed).toEqual(adapterFiles);
  });

  test("pi's OWN loader discovers and loads the whole adapter — the check that was missing", async () => {
    // By file path: the package's exports map does not expose the subpath,
    // and this test wants the real loader, not a re-declaration of it.
    const loaderPath = join(AGENT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "loader.js");
    const loader = (await import(loaderPath)) as {
      discoverAndLoadExtensions: (paths: string[], cwd: string, agentDir: string) => Promise<{
        extensions: readonly { path?: string }[];
        errors: readonly unknown[];
      }>;
    };
    const result = await loader.discoverAndLoadExtensions([], AGENT, AGENT);
    expect(result.errors).toEqual([]);
    const loaded = result.extensions
      .map((e: { path?: string }) => e.path ?? "")
      .filter((p: string) => p.includes("hosts/pi/extensions/"))
      .map((p: string) => p.split("hosts/pi/extensions/")[1])
      .sort();
    expect(loaded).toEqual(["architect-tools.ts", "dev-tools.ts", "model-tier.ts", "path-gate.ts", "web.ts"]);
  });

  test("the drop zone itself carries no stray loadable file the scan would pick up", () => {
    // Direct *.ts / *.js files in extensions/ load unconditionally; only
    // tool-managed files (gitignored by their tool's prefix) belong there.
    const tracked = readdirSync(join(AGENT, "extensions")).filter(
      (name) => (name.endsWith(".ts") || name.endsWith(".js")) && !name.startsWith("orca-"),
    );
    expect(tracked).toEqual([]);
  });
});
