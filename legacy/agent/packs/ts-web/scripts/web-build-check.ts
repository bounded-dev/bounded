// check:build — bundle every web app the design declares (dogfood Run 29).
//
// SHIPPED into the project as scripts/web-build-check.ts and run by the
// generated `check:build` script (`bun scripts/web-build-check.ts`), so a
// delivered repo's own `check` fails when a web client does not bundle. It is
// self-contained: Node built-ins and the `bun` executable only.
//
// Which apps are web apps is the DESIGN's statement, not a guess from the
// tree: the `workspaces:` maps in the ticket TNs' front matter (TN-26-012 §9)
// name each app and its kind. A project that composed ts-web but declares no
// web app (a desktop-only project, or one whose design has not reached its
// apps yet) has nothing to build, and says so.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = /^ {2}([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*): ([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

/** The front matter of a TN, or undefined when it has none. */
function frontMatter(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  return end < 0 ? undefined : lines.slice(1, end);
}

/**
 * Every workspace the TNs under docs/tn declare, as directory → kind, sorted
 * by directory. A malformed map, or one directory declared with two kinds,
 * throws with the file that says so.
 */
export function declaredWorkspaces(cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(cwd, "docs", "tn");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const lines = frontMatter(readFileSync(join(dir, name), "utf8")) ?? [];
    const start = lines.indexOf("workspaces:");
    if (start < 0) continue;
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith(" ")) break;
      const match = ENTRY.exec(line);
      if (match === null) throw new Error(`docs/tn/${name}: '${line}' is not a workspaces entry (  <dir>: <kind>)`);
      const [, workspace, kind] = match as unknown as [string, string, string];
      const other = out.get(workspace);
      if (other !== undefined && other !== kind) {
        throw new Error(`docs/tn/${name}: ${workspace} is declared as both ${other} and ${kind}`);
      }
      out.set(workspace, kind);
    }
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The declared web apps' directories, sorted. */
export function declaredWebApps(cwd: string): string[] {
  return [...declaredWorkspaces(cwd)].filter(([, kind]) => kind === "web").map(([dir]) => dir);
}

/** Bundle each declared web app's client page; the lines to print and the exit code. */
export function runWebBuildCheck(cwd: string): { code: number; lines: string[] } {
  let apps: string[];
  try {
    apps = declaredWebApps(cwd);
  } catch (error) {
    return { code: 1, lines: [`check:build: ${(error as Error).message}`] };
  }
  if (apps.length === 0) return { code: 0, lines: ["check:build: no web app is declared (TN workspaces) — nothing to build"] };
  const lines: string[] = [];
  let code = 0;
  for (const app of apps) {
    const page = join(app, "src", "client", "index.html");
    if (!existsSync(join(cwd, page))) {
      lines.push(`check:build: ${app} is declared as a web app but has no ${page}`);
      code = 1;
      continue;
    }
    const out = mkdtempSync(join(tmpdir(), "check-build-"));
    try {
      const run = spawnSync("bun", ["build", page, "--outdir", out], { cwd, encoding: "utf8" });
      if (run.status === 0) {
        lines.push(`check:build: ${app} bundles`);
      } else {
        lines.push(`check:build: ${app} does not bundle`, ...`${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n"));
        code = 1;
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
  return { code, lines };
}

if (process.argv[1] !== undefined && /web-build-check\.[cm]?[jt]s$/.test(process.argv[1])) {
  const result = runWebBuildCheck(process.cwd());
  for (const line of result.lines) console.log(line);
  process.exitCode = result.code;
}
