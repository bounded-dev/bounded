// The service runtime as a contract support file (TN-26-004, ADR 2026-046).
//
// A contract imports "./service-runtime.js" to declare itself a service
// component; the ts scaffolder and red gate answer by shipping this pack's
// canonical runtime to that exact path. The specifier is the address, so the
// copy always lands where the contract is already pointing. Only a project
// that composed ts-trpc reaches this file.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContractSupportFile } from "../ts/pack.ts";

const SERVICE_RUNTIME_SPECIFIER = /from\s+["']([^"']*service-runtime)\.js["']/g;

/** Absolute .ts paths this contract's service-runtime imports resolve to,
 *  deduplicated. Empty for a contract that never mentions the runtime. */
export function serviceRuntimeTargets(contractSource: string, contractPath: string): string[] {
  const out = new Set<string>();
  for (const match of contractSource.matchAll(SERVICE_RUNTIME_SPECIFIER)) {
    out.add(resolve(dirname(contractPath), `${match[1]!}.ts`));
  }
  return [...out].sort();
}

export const SERVICE_RUNTIME_CANONICAL = "packs/ts-trpc/api/service-runtime.ts";

export const serviceRuntimeSupport: ContractSupportFile = {
  label: "API-service runtime",
  canonical: SERVICE_RUNTIME_CANONICAL,
  targets: serviceRuntimeTargets,
  source: () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "api", "service-runtime.ts"), "utf8"),
  dependencies: ["@trpc/server"],
};
