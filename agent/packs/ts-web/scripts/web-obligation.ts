// The delivery obligation of a project that composed ts-web (ADR 2026-036):
// at least one web app exists, and each has the whole door — a server entry
// hosting the router and a client page with its script. Read-only, keyed on
// the tree: a web app is an `apps/<name>/` whose source has a client page.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DeliverCheckResult } from "../../ts/pack.ts";

const REQUIRED = ["src/client/index.html", "src/client/main.tsx", "src/server/main.ts", "src/server/composition-root.ts"];

/** App directories (`apps/<name>`) that carry a client page, sorted. */
export function webApps(cwd: string): string[] {
  const root = join(cwd, "apps");
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root).sort().filter((name) => existsSync(join(root, name, "src", "client", "index.html")))
    .map((name) => `apps/${name}`);
}

export function runWebObligation(cwd: string): DeliverCheckResult {
  const apps = webApps(cwd);
  if (apps.length === 0) {
    return { verdict: "block", summary: "ts-web: no web app — declare one in a TN's workspaces map (apps/web: web)" };
  }
  const missing = apps.flatMap((app) => REQUIRED.filter((file) => !existsSync(join(cwd, app, file))).map((file) => `${app}/${file}`));
  if (missing.length > 0) {
    return { verdict: "block", summary: "ts-web: a web app is missing part of its door", detail: missing };
  }
  return { verdict: "pass", summary: `ts-web: ${apps.join(", ")} serve a client page and the router` };
}
