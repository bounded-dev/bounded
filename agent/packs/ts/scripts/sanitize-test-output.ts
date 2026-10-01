// run_tests output sanitizer (TN-26-001, §"Custom tools"; ADR 2026-062).
//
// The builder is blind to test SOURCE but must see failure output to debug.
// So run_tests may surface ONLY: the test's name, its status, and a failure
// message that keeps the error's name and text (with any expected/received
// diff) while dropping everything that can carry test source: code frames,
// stack frames, file paths, console output, and any line that quotes a test
// file.
//
// `bun test` writes two things, and neither alone is enough:
//
//   · the JUnit report (`--reporter=junit`): every test's name, its enclosing
//     `describe` blocks and its status. It carries NO failure text. Names and
//     statuses are taken from here and nowhere else, so which tests exist and
//     how they ended is whitelisted by construction: the parser reads the
//     `name` attributes of `testsuite`/`testcase` and the presence of a
//     `failure`/`error`/`skipped` child, and never reads a path, line, text
//     node or any other attribute.
//   · the console report on stderr: for each failed test, a block ending in
//     `(fail) <describe> > … > <name>`. The block may start with the test's
//     own console.error output, then a code frame of the line that threw (test
//     source!), a caret line, the error header (`error: …`, `TypeError: …`),
//     the error's text and diff, and stack frames with absolute paths. Errors
//     outside any test (a test file that fails to load, a throw at module
//     scope) print as `# Unhandled error between tests` blocks instead, and
//     are absent from the JUnit report.
//
// The message is extracted by a WHITELIST WINDOW: it starts after the last
// caret line (so console output and the code frame are behind it), or, with
// no frame, at the last error header; it stops at the first stack frame. Then
// every line is filtered again (frame, caret, console-capture and reporter
// lines dropped; paths redacted to `[path]`; ANSI escapes stripped), and,
// last, any line that contains a line of a test file is dropped
// (`forbiddenLines`): a test that throws its own source text, or an error that
// quotes it, still cannot put that source in front of the builder. The last
// step is what makes the guarantee provable: whatever bun prints, no line of a
// test file of eight or more characters survives (sanitize-test-output.test.ts).
//
// Pure: no fs, no spawn. run-tests.ts spawns bun, reads the report and the
// test files, and calls in here.

export class SanitizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SanitizeError";
  }
}

/**
 * One test's sanitized outcome — the entire public surface run_tests exposes.
 *
 * - `name`    the test's full name: its `describe` blocks and its own title,
 *             joined with ` > ` (bun's own spelling). Chosen by the
 *             test-writer; carries no source.
 * - `status`  `passed`, `failed`, `skipped` or `todo`.
 * - `message` failures only, and only when sanitizing leaves text.
 */
export interface SanitizedResult {
  readonly name: string;
  readonly status: string;
  readonly message?: string;
  /** The project-relative test file the result came from, when the report
   *  names one. The gates read it (a generated law is judged apart from a
   *  hand-written test); the builder's run_tests view never prints it. */
  readonly file?: string;
}

// --- shared line filters ------------------------------------------------------

// Paths are redacted by WHAT THEY ARE, not by their shape: a slash-led value
// in an assertion (`"/api/projects/create"`, a regex) is the builder's
// debugging data and stays. What goes is a real filesystem location: any
// path under a machine root the caller names (the project, the temp
// directory, the home directory), with an optional `file://` and trailing
// `:line:col`; any test file named by its project path or its file name;
// and any Windows drive path. Stack frames and code frames are dropped whole
// before this runs, so they never depend on it.
const WINDOWS_PATH = /[A-Za-z]:\\[\w.\-\\]*/g;
const PATH_PLACEHOLDER = "[path]";

/** What the sanitizer knows about the run it is cleaning. */
export interface SanitizeContext {
  /** Lines of test files that must never survive ({@link forbiddenLines}). */
  readonly forbidden?: ReadonlySet<string>;
  /** Absolute machine directories: every path under one is redacted. */
  readonly pathRoots?: readonly string[];
  /** Project-relative paths of test-side files: redacted wherever they, or
   *  their file names, appear. */
  readonly testPaths?: readonly string[];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const PATH_TAIL = "(?:[\\/\\\\][^\\s'\"`()<>\\[\\]{},;:]*)?(?::\\d+(?::\\d+)?)?";

function pathRedactors(ctx: SanitizeContext): RegExp[] {
  const roots = [...new Set((ctx.pathRoots ?? []).map((r) => r.replace(/[\\/]+$/, "")).filter((r) => r.length > 1))]
    .sort((a, b) => b.length - a.length);
  const out = roots.map((root) => new RegExp(`(?:file:\\/\\/)?${escapeRegExp(root)}${PATH_TAIL}`, "g"));
  const names = new Set<string>();
  for (const path of ctx.testPaths ?? []) {
    names.add(path);
    names.add(path.split("/").at(-1)!);
  }
  for (const name of [...names].filter((n) => n !== "").sort((a, b) => b.length - a.length)) {
    out.push(new RegExp(`(?<![\\w.-])(?:file:\\/\\/)?(?:\\/|\\.{1,2}\\/)?(?:[\\w.@-]+\\/)*${escapeRegExp(name)}(?::\\d+(?::\\d+)?)?(?![\\w-])`, "g"));
  }
  out.push(WINDOWS_PATH);
  return out;
}

const asContext = (ctx: SanitizeContext | ReadonlySet<string> | undefined): SanitizeContext =>
  ctx === undefined ? {} : ctx instanceof Set ? { forbidden: ctx } : (ctx as SanitizeContext);
// ANSI SGR, cursor and OSC sequences.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** Lines dropped wholesale — each leaks source or is pure reporter chrome. */
function isSourceLeakingLine(line: string): boolean {
  const t = line.trimStart();
  return (
    // stack frames: "at fn (…:1:2)", "at …:1:2", "❯ …:1:2"
    /^at\s/.test(t) ||
    /^❯\s/.test(t) ||
    // code-frame numbered source line: " 6 | expect(secret)…"
    /^\d+\s*\|/.test(t) ||
    // code-frame gutter / caret pointer line: " |   ^", "      ^"
    /^\|/.test(t) ||
    /^\^\s*$/.test(t) ||
    // console capture headers: "stdout | file > test", "stderr | …"
    /^(?:stdout|stderr)\s*\|/.test(t) ||
    // bun's per-test chrome: "(fail) a > b [1ms]", "^ this test timed out…"
    /^\((?:fail|pass|skip|todo)\)\s/.test(t) ||
    /^\^\s+this test/.test(t) ||
    // reporter decoration: separator rules and "[1/2]" progress markers
    /^[⎯\-─\s]*$/.test(line) ||
    /⎯*\[\d+\/\d+\]⎯*/.test(line)
  );
}

/**
 * Lines of test files that must never reach the builder: every line of every
 * test-side file, trimmed, of at least {@link FORBIDDEN_MIN_LENGTH}
 * characters (shorter lines — `});`, `} else {` — carry no source worth
 * hiding and would match harmless output).
 */
export const FORBIDDEN_MIN_LENGTH = 8;

export function forbiddenLines(sources: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const source of sources) {
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= FORBIDDEN_MIN_LENGTH) out.add(trimmed);
    }
  }
  return out;
}

function quotesForbidden(line: string, forbidden: ReadonlySet<string>): boolean {
  if (forbidden.size === 0) return false;
  const trimmed = line.trim();
  if (trimmed.length < FORBIDDEN_MIN_LENGTH) return false;
  if (forbidden.has(trimmed)) return true;
  for (const source of forbidden) if (trimmed.includes(source)) return true;
  return false;
}

const MAX_MESSAGE_LINES = 40;
const MAX_MESSAGE_CHARS = 4000;

/**
 * Strip source-leaking material from one piece of free text while keeping
 * the error text and any expected/received diff: ANSI escapes, stack and
 * code-frame lines, console-capture headers and reporter chrome are dropped;
 * real filesystem paths are redacted to `[path]` (see the context); any line
 * quoting a forbidden test line is dropped. Blank-line runs collapse; the
 * result is bounded.
 */
export function sanitizeMessage(message: string, context?: SanitizeContext | ReadonlySet<string>): string {
  const ctx = asContext(context);
  const forbidden = ctx.forbidden ?? new Set<string>();
  const redactors = pathRedactors(ctx);
  const kept: string[] = [];
  for (const rawLine of message.replace(ANSI, "").split(/\r?\n/)) {
    if (isSourceLeakingLine(rawLine)) continue;
    if (quotesForbidden(rawLine, forbidden)) continue;
    const redacted = redactors.reduce((line, pattern) => line.replace(pattern, PATH_PLACEHOLDER), rawLine);
    if (quotesForbidden(redacted, forbidden)) continue;
    kept.push(redacted);
  }
  let text = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  const lines = text.split("\n");
  if (lines.length > MAX_MESSAGE_LINES) text = [...lines.slice(0, MAX_MESSAGE_LINES), "…"].join("\n");
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}…`;
  return text;
}

// --- JUnit report -------------------------------------------------------------

/** One test case read from the JUnit report. */
export interface JUnitCase {
  /** `describe` names and the test's own name, joined with ` > `. */
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped" | "todo";
  /** The failure element's `type` attribute, when one is present. */
  readonly failureType?: string;
  /** The project-relative test file, when the report names a relative one. */
  readonly file?: string;
}

/** A report's file attribute, kept only when it is a plain relative path. */
function relativeFile(value: string | undefined): string | undefined {
  if (value === undefined || value === "" || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) return undefined;
  const segments = value.split("/");
  return segments.some((s) => s === "" || s === "." || s === "..") ? undefined : value;
}

const ENTITY: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITY[body] ?? whole;
  });
}

interface Tag {
  readonly kind: "open" | "close" | "self";
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
}

const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The element tags of an XML document in order. Comments, CDATA, the
 *  declaration and every text node are skipped: nothing but tag names and
 *  attributes is ever read. */
function tags(xml: string): Tag[] {
  const stripped = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  const out: Tag[] = [];
  for (const match of stripped.matchAll(TAG)) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[3] ?? "").matchAll(ATTRIBUTE)) {
      attributes.set(attribute[1]!, decodeEntities(attribute[2] ?? attribute[3] ?? ""));
    }
    const kind = match[1] === "/" ? "close" : match[4] === "/" ? "self" : "open";
    out.push({ kind, name: match[2]!, attributes });
  }
  return out;
}

/**
 * Parse `bun test --reporter=junit` output into test cases, in report order.
 * The outermost `testsuite` of each file is named by the file's path and is
 * dropped; each nested `testsuite` is a `describe` block. Throws
 * {@link SanitizeError} when the text is not a JUnit report.
 */
export function parseJUnitReport(xml: string): JUnitCase[] {
  const all = tags(xml);
  if (!all.some((t) => t.name === "testsuites" && t.kind !== "close")) {
    throw new SanitizeError("sanitize: input is not a JUnit report (no <testsuites> element)");
  }
  const cases: JUnitCase[] = [];
  const suites: string[] = [];
  const files: (string | undefined)[] = [];
  let open: { name: string; status: JUnitCase["status"]; failureType?: string; file?: string } | undefined;
  for (const tag of all) {
    if (tag.name === "testsuite") {
      if (tag.kind === "open") {
        suites.push(tag.attributes.get("name") ?? "");
        files.push(tag.attributes.get("file") ?? files.at(-1));
      } else if (tag.kind === "close") {
        suites.pop();
        files.pop();
      }
      continue;
    }
    if (tag.name === "testcase") {
      if (tag.kind === "close") {
        if (open !== undefined) cases.push(open);
        open = undefined;
        continue;
      }
      // suites[0] is the file (a path): never part of the name.
      const name = [...suites.slice(1), tag.attributes.get("name") ?? ""].filter((s) => s !== "").join(" > ");
      const file = relativeFile(tag.attributes.get("file") ?? files.at(-1));
      const entry = { name, status: "passed" as JUnitCase["status"], ...(file !== undefined ? { file } : {}) };
      if (tag.kind === "self") cases.push(entry);
      else open = entry;
      continue;
    }
    if (open === undefined) continue;
    if ((tag.name === "failure" || tag.name === "error") && tag.kind !== "close") {
      const type = tag.attributes.get("type");
      open = { ...open, status: "failed", ...(type !== undefined && /^\w+$/.test(type) ? { failureType: type } : {}) };
    } else if (tag.name === "skipped" && tag.kind !== "close" && open.status !== "failed") {
      open = { ...open, status: tag.attributes.get("message") === "TODO" ? "todo" : "skipped" };
    }
  }
  return cases;
}

// --- stderr: failure blocks and unhandled errors ---------------------------------

// bun's genuine marker always carries the test's duration.
const FAIL_LINE = /^\(fail\) (.*) \[\d+(?:\.\d+)?m?s\]$/;
const CARET_LINE = /^\s*\^\s*$/;
const ERROR_HEADER = /^(?:error|[A-Z][A-Za-z0-9]*(?:Error|Exception))(?::|$)/;
const STACK_FRAME = /^\s+at\s/;
const UNHANDLED_HEADER = /^# Unhandled error/;
const RULE = /^-{3,}\s*$/;
const FILE_HEADER = /^\S.*\.(?:[cm]?[jt]sx?):$/;

/** The error text inside one stderr block, before any line filtering:
 *  from just after the last caret (or the last error header when there is no
 *  frame) up to the first stack frame. Undefined when the block has neither. */
function errorWindow(lines: readonly string[]): string[] | undefined {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CARET_LINE.test(lines[i]!)) { start = i + 1; break; }
  }
  if (start === -1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (ERROR_HEADER.test(lines[i]!.trimStart())) { start = i; break; }
    }
  }
  if (start === -1) return undefined;
  const out: string[] = [];
  for (const line of lines.slice(start)) {
    if (STACK_FRAME.test(line)) break;
    out.push(line);
  }
  return out;
}

export interface StderrReport {
  /** Failure text per `(fail)` full name, in order of appearance (a name can repeat). */
  readonly failures: ReadonlyMap<string, readonly string[]>;
  /** One text per `# Unhandled error` block. */
  readonly unhandled: readonly string[];
  /** The summary's error count (` 2 errors`), 0 when absent. */
  readonly errorCount: number;
}

/**
 * Split bun's console report into per-test failure text and unhandled-error
 * text, each already sanitized with `context`. Pure over the captured text.
 *
 * Console output is on the same stream as the report, so a marker is only
 * believed when it could be bun's own: `(fail) <name> [<duration>]` for a
 * name the JUnit report lists as failed (`expectedFailures`, counts per
 * name), no more often than the report says. Any other marker-shaped line is
 * ordinary text inside a window, and every window starts after bun's own
 * caret. The runner also silences console output in the test process
 * (bun-test-preload.ts), so imitating a marker takes a deliberate raw write
 * to the process's error stream (ADR 2026-062, known limits).
 */
export function readStderrReport(
  stderr: string,
  context?: SanitizeContext | ReadonlySet<string>,
  expectedFailures?: ReadonlyMap<string, number>,
): StderrReport {
  const lines = stderr.replace(ANSI, "").split(/\r?\n/);
  const failures = new Map<string, string[]>();
  const pending = expectedFailures === undefined ? undefined : new Map(expectedFailures);
  const unhandled: string[] = [];
  let block: string[] = [];
  let inUnhandled = false;
  let unhandledRules = 0;
  let errorCount = 0;
  const ctx = asContext(context);
  const text = (window: string[] | undefined): string => (window === undefined ? "" : sanitizeMessage(window.join("\n"), ctx));
  for (const line of lines) {
    if (inUnhandled) {
      if (RULE.test(line)) {
        unhandledRules += 1;
        if (unhandledRules === 2) {
          unhandled.push(text(errorWindow(block)));
          inUnhandled = false;
          block = [];
        }
      } else if (unhandledRules === 1) block.push(line);
      continue;
    }
    if (UNHANDLED_HEADER.test(line)) {
      inUnhandled = true;
      unhandledRules = 0;
      block = [];
      continue;
    }
    const failed = FAIL_LINE.exec(line);
    const left = failed === null || pending === undefined ? undefined : pending.get(failed[1]!) ?? 0;
    if (failed !== null && (left === undefined || left > 0)) {
      const name = failed[1]!;
      if (pending !== undefined) pending.set(name, left! - 1);
      const list = failures.get(name) ?? [];
      list.push(text(errorWindow(block)));
      failures.set(name, list);
      block = [];
      continue;
    }
    if (FILE_HEADER.test(line) || /^\((?:pass|skip|todo)\)\s/.test(line)) {
      block = [];
      continue;
    }
    const summary = /^\s*(\d+) errors?\s*$/.exec(line);
    if (summary !== null) errorCount = Number(summary[1]);
    block.push(line);
  }
  if (inUnhandled && block.length > 0) unhandled.push(text(errorWindow(block)));
  return { failures, unhandled, errorCount };
}

/** The name given to an error raised outside any test. */
export const UNHANDLED_NAME = "(outside any test)";

/** Fixed text for a timed-out test: bun's own timeout note carries no more. */
export const TIMEOUT_MESSAGE = "TimeoutError: the test did not finish within its time limit";

/** Fixed text for an unhandled error whose block could not be read. */
export const UNREADABLE_UNHANDLED = "an error was raised outside any test (for example, a test file failed to load)";

/**
 * Sanitize one `bun test` run: the JUnit report for names and statuses, the
 * console report for failure text. Each error raised outside any test becomes
 * one failed result named {@link UNHANDLED_NAME}, so a suite that could not
 * load a file is never green and never a clean red.
 */
export function sanitizeBunRun(
  junitXml: string,
  stderr: string,
  context?: SanitizeContext | ReadonlySet<string>,
): SanitizedResult[] {
  const cases = parseJUnitReport(junitXml);
  const expected = new Map<string, number>();
  for (const c of cases) if (c.status === "failed") expected.set(c.name, (expected.get(c.name) ?? 0) + 1);
  const report = readStderrReport(stderr, context, expected);
  const used = new Map<string, number>();
  const results: SanitizedResult[] = cases.map((c) => {
    const file = c.file !== undefined ? { file: c.file } : {};
    if (c.status !== "failed") return { name: c.name, status: c.status, ...file };
    if (c.failureType === "TimeoutError") return { name: c.name, status: "failed", message: TIMEOUT_MESSAGE, ...file };
    const index = used.get(c.name) ?? 0;
    used.set(c.name, index + 1);
    const message = report.failures.get(c.name)?.[index];
    return message === undefined || message === "" ? { name: c.name, status: "failed", ...file } : { name: c.name, status: "failed", message, ...file };
  });
  const unhandled = Math.max(report.unhandled.length, report.errorCount);
  for (let i = 0; i < unhandled; i++) {
    const message = report.unhandled[i];
    results.push({ name: UNHANDLED_NAME, status: "failed", message: message === undefined || message === "" ? UNREADABLE_UNHANDLED : message });
  }
  return results;
}
