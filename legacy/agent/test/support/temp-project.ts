import { writeProjectPacks } from "../../src/project-composition.ts";
// Temp project — a throwaway target directory for a gate test.
//
// Two dozen test files each roll their own mkdtemp + writeFileSync + rmSync;
// this is the shared version for tests written from ADR 2026-029 on. Files are
// given as project-relative paths (nested directories are created), and
// `nodeModules: true` links the harness's own node_modules into the project so
// `npx tsc` and `npx vitest` resolve locally and never reach for the network.
// Older tests are left as they are on purpose — a migration is not a feature.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TempProject {
  readonly dir: string;
  /** Remove the directory. Idempotent; never throws. */
  cleanup(): void;
}

export interface TempProjectOptions {
  /** mkdtemp prefix, so a leftover directory says which test made it. */
  readonly prefix?: string;
  /** Symlink the harness's node_modules into the project. */
  readonly nodeModules?: boolean;
  /** The composed packs (default: the ts pack alone). */
  readonly packs?: readonly string[];
}

const HARNESS_NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules");

export function makeTempProject(
  files: Readonly<Record<string, string>>,
  options: TempProjectOptions = {},
): TempProject {
  const dir = mkdtempSync(join(tmpdir(), options.prefix ?? "bounded-harness-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  writeProjectPacks(dir, options.packs ?? ["ts"]);
  if (options.nodeModules) symlinkSync(HARNESS_NODE_MODULES, join(dir, "node_modules"), "dir");
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
