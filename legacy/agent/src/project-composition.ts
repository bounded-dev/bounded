// Project selection is data shared by every host and gate (ADR 2026-036).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const COMPOSITION_FILE = ".bounded/composed-packs.json";

function checked(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) ||
      new Set(value).size !== value.length) {
    throw new Error(`${COMPOSITION_FILE} must be a nonempty array of unique pack names`);
  }
  return value as string[];
}

export function readProjectPacks(cwd: string): readonly string[] {
  try {
    return checked(JSON.parse(readFileSync(join(cwd, COMPOSITION_FILE), "utf8")));
  } catch (error) {
    throw new Error(`Cannot read project composition: ${error instanceof Error ? error.message : String(error)}. ` +
      "Declare the intended capabilities with bounded compose --cwd <project> <pack>... before running gates.");
  }
}

export function writeProjectPacks(cwd: string, packs: readonly string[]): void {
  const selection = checked(packs);
  mkdirSync(join(cwd, ".bounded"), { recursive: true });
  writeFileSync(join(cwd, COMPOSITION_FILE), JSON.stringify([...selection].sort(), null, 2) + "\n");
}
