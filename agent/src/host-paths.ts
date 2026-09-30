// What each host does to a path argument before it touches the filesystem
// (ADR 2026-057). The path policy judges a project-relative spelling; a host
// that rewrites the argument first — strips a prefix, expands `~`, decodes a
// URL — would otherwise open a file the gate never judged. So the gate
// applies exactly the host's own rewriting first, and refuses a form it
// cannot prove the host treats the same way.
//
// Pure except `piReadVariant`, which asks the filesystem the question pi's
// read tool asks.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type PathHost = "pi" | "claude-code";

export type HostPath = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

// pi 0.84.2, dist/utils/paths.js: `const UNICODE_SPACES = /[  -   　]/g;`
const PI_UNICODE_SPACES = /[  -   　]/g;

/**
 * pi's `resolveToCwd(path, cwd)` (dist/core/tools/path-utils.js) is
 * `resolvePath(path, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true })`,
 * whose `normalizePath` (dist/utils/paths.js) does, in order: unicode spaces
 * to ' ', strip ONE leading '@', (Windows shell paths — not a supported host
 * platform), '~' → home and '~/x' → home/x, then a `file://` URL through
 * `fileURLToPath`. read, write, edit, ls, find and grep all resolve their
 * path this way. This mirrors it step for step.
 */
export function piPathArgument(raw: string, home: string = homedir()): HostPath {
  let normalized = raw.replace(PI_UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return { ok: true, path: home };
  if (normalized.startsWith("~/")) return { ok: true, path: join(home, normalized.slice(2)) };
  if (/^file:\/\//.test(normalized)) {
    try {
      return { ok: true, path: fileURLToPath(normalized) };
    } catch {
      return { ok: false, reason: `'${raw}' is a file URL pi cannot decode — pass the plain project path` };
    }
  }
  return { ok: true, path: normalized };
}

/**
 * Claude Code's file tools take a path, and whether a given version expands
 * `~`, strips an `@` mention prefix or decodes a `file:` URL is not something
 * the gate can prove. Each form is therefore refused: the plain absolute or
 * project-relative path means the same thing to both.
 */
export function claudeCodePathArgument(raw: string): HostPath {
  if (raw.startsWith("~")) return { ok: false, reason: `'${raw}' starts with '~', which this host may expand — pass the absolute project path` };
  if (/^file:/i.test(raw)) return { ok: false, reason: `'${raw}' is a file URL — pass the absolute project path` };
  if (raw.startsWith("@")) return { ok: false, reason: `'${raw}' starts with '@', which this host may strip — pass the path without it` };
  return { ok: true, path: raw };
}

export function hostPathArgument(host: PathHost, raw: string, home?: string): HostPath {
  return host === "pi" ? piPathArgument(raw, home) : claudeCodePathArgument(raw);
}

/**
 * pi's read tool (`resolveReadPath`, dist/core/tools/path-utils.js) opens a
 * DIFFERENT spelling when the resolved path does not exist: a narrow no-break
 * space before AM/PM, the NFD form, a curly apostrophe, or NFD plus curly
 * apostrophe — the first that exists. Returns that spelling when pi would
 * substitute it, so the gate can refuse a read of a file it did not judge.
 */
export function piReadVariant(absolute: string): string | undefined {
  if (existsSync(absolute)) return undefined;
  const nfd = absolute.normalize("NFD");
  const candidates = [
    absolute.replace(/ (AM|PM)\./gi, " $1."),
    nfd,
    absolute.replace(/'/g, "’"),
    nfd.replace(/'/g, "’"),
  ];
  return candidates.find((candidate) => candidate !== absolute && existsSync(candidate));
}
