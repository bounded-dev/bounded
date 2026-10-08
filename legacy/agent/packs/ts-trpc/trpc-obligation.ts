// The delivery obligation of a project that composed ts-trpc (ADR LEG-2026-036):
// at least one context exposes a feature through tRPC, so its generated
// adapter exists. Composing the pack and exposing nothing is a design that
// asked for an API and never declared one. Read-only, keyed on the tree.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DeliverCheckResult } from "../ts/pack.ts";

/** Contexts whose generated tRPC barrel exists, sorted. */
export function contextsWithTrpc(cwd: string): string[] {
  const root = join(cwd, "contexts");
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root).sort()
    .filter((name) => existsSync(join(root, name, "src", "adapters", "in", "trpc", "index.ts")));
}

export function runTrpcObligation(cwd: string): DeliverCheckResult {
  const contexts = contextsWithTrpc(cwd);
  if (contexts.length === 0) {
    return {
      verdict: "block",
      summary: "ts-trpc: no context exposes a feature through tRPC — tag an in port `@exposedVia trpc`, or drop the pack",
    };
  }
  return { verdict: "pass", summary: `ts-trpc: generated tRPC adapter in ${contexts.join(", ")}` };
}
