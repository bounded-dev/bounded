import { readFileSync } from "node:fs";
import { join } from "node:path";

export const candidateTargetIds = [
  "darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-arm64-musl",
  "linux-x64-gnu", "linux-x64-musl", "windows-arm64", "windows-x64",
] as const;

export function readDeclaredReleaseTargets(version: string): readonly string[] {
  const raw: unknown = JSON.parse(readFileSync(join(import.meta.dir, "release-targets.json"), "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("release target declaration is malformed");
  const declaration = raw as Record<string, unknown>;
  if (Object.keys(declaration).sort().join() !== "schema,targets,version" || declaration.schema !== "bounded-release-targets/1" || declaration.version !== version) {
    throw new Error(`release target declaration must match version ${version}`);
  }
  const ids = declaration.targets;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !candidateTargetIds.includes(id as (typeof candidateTargetIds)[number])) || new Set(ids).size !== ids.length || ids.join() !== [...ids].sort().join()) {
    throw new Error("release target declaration requires a sorted nonempty unique candidate subset");
  }
  return ids;
}
