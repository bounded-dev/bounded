// A seat re-reading its own saved tool output (ADR 2026-069).
//
// When a tool result is too large for the context, Claude Code saves it to
// `<projects-dir>/<session_id>/tool-results/<name>.txt` and hands the caller a
// preview that says "Full output saved to: <path>". That file is outside the
// project, so the path gate refuses the follow-up Read. Every subagent of a
// session writes to that one directory, so "any file of this session" would
// let a blind test-writer read a parallel builder's output. The rule is
// narrower: an agent may Read a saved output only when its OWN transcript
// records that its own call produced it.
//
// The transcript layout is Claude Code's and undocumented, so every check
// fails closed: anything not recognised exactly is refused, as before.
//
//   <projects-dir>/<session_id>.jsonl                        the main transcript (transcript_path)
//   <projects-dir>/<session_id>/subagents/agent-<id>.jsonl   a subagent's transcript
//   <projects-dir>/<session_id>/tool-results/<name>.txt      every agent's saved outputs
//
// A record proves ownership when it is a `user` record holding a
// `tool_result` whose text starts with exactly
//
//   <persisted-output>
//   Output too large (<size>). Full output saved to: <path>
//
//   Preview (first <size>):
//   <the saved file's own first bytes>
//
// for the requested path, and whose `tool_use_id` names a `tool_use` an
// earlier `assistant` record of the same transcript made. The preview must
// begin with the file's own first PREVIEW_PROOF_BYTES bytes (all of a shorter
// file): a seat's own tool can print the header lines, but it cannot print
// another seat's output it has never seen.
//
// No refusal names the file: another seat must not learn a saved output's
// name from a refusal or the guard log.
//
// Reads files, nothing else: no logging, no process state.

import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Hook payload facts, none of which the model controls. */
export interface SpillFacts {
  readonly transcriptPath?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  /** Whether a call with no agent id is the session's own top-level seat,
   *  whose transcript is the main one. A role seat never is: with no agent
   *  id its own transcript cannot be told apart, so it is refused. */
  readonly topLevelSeat: boolean;
}

export type SpillVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

/** How a saved output is named in every refusal. */
export const SAVED_OUTPUT = "a saved tool output";
/** How much of the saved file its preview must reproduce. */
export const PREVIEW_PROOF_BYTES = 1024;
/** The only tool a saved output may be re-read with. */
const READ_TOOL = "Read";
/** An id Claude Code uses as a file or directory name. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** A saved output's own file name. */
const SPILL_NAME = /^[A-Za-z0-9_-]+\.txt$/;
const HEADER_OPEN = "<persisted-output>";
const HEADER_SAVED = /^Output too large \([^)]*\)\. Full output saved to: (.+)$/;
const PREVIEW_LEAD_IN = /^\n\nPreview \(first [^)\n]*\):\n/;
const RESULTS_DIR = "/tool-results/";

/**
 * Judge a Read of one of this session's saved outputs. `undefined` when the
 * call is not such a read at all — another tool, no session to locate, or a
 * path not spelled under this session's `tool-results/` — and the caller's
 * usual dispatch judges it. The raw path alone decides that; resolving it only
 * decides allow or refuse for a call this function owns.
 */
export function spillRead(toolName: string, toolInput: Readonly<Record<string, unknown>>, facts: SpillFacts): SpillVerdict | undefined {
  if (toolName !== READ_TOOL) return undefined;
  const path = toolInput["file_path"];
  if (typeof path !== "string") return undefined;
  const session = sessionDir(facts);
  if (session === undefined) return undefined;
  const results = join(session, "tool-results");
  if (!path.startsWith(`${results}/`)) return undefined;

  const refuse = (why: string): SpillVerdict => ({
    allow: false,
    reason: `may not read ${SAVED_OUTPUT}: it is a Claude Code saved output, which only the agent whose own call produced it may re-read, and ${why}`,
  });
  if (!SPILL_NAME.test(path.slice(results.length + 1))) return refuse("it is not a file directly in this session's tool-results directory");
  let head: string;
  try {
    if (!lstatSync(path).isFile()) return refuse("it is a link or not a plain file");
    if (realpathSync(dirname(path)) !== realpathSync(results)) return refuse("it is not a file directly in this session's tool-results directory");
    head = fileHead(path);
  } catch {
    return refuse("it could not be inspected");
  }
  const own = transcriptOf(session, facts);
  if (own === undefined) return refuse("this agent's own transcript cannot be located, so ownership cannot be proven");
  let text: string;
  try {
    text = readFileSync(own, "utf8");
  } catch {
    return refuse("this agent's transcript could not be read, so ownership cannot be proven");
  }
  const owned = recordsOwnSpill(text, path, head);
  if (owned === undefined) return refuse("this agent's transcript could not be parsed, so ownership cannot be proven");
  return owned ? { allow: true } : refuse("this agent's transcript does not show that its own call produced it");
}

/**
 * A Read of some saved tool output that `spillRead` did not own: an absolute
 * path outside the project with a `tool-results/` directory in it. It is
 * refused as any read outside the project is, but in words that do not name
 * the file.
 */
export function foreignSpillRead(toolName: string, toolInput: Readonly<Record<string, unknown>>, cwd: string): string | undefined {
  if (toolName !== READ_TOOL) return undefined;
  const path = toolInput["file_path"];
  if (typeof path !== "string" || !isAbsolute(path) || path.startsWith(`${cwd}/`) || !path.includes(RESULTS_DIR)) return undefined;
  return `may not read ${SAVED_OUTPUT}: absolute path outside project root, and not one this agent's own call saved in this session`;
}

/** `<projects-dir>/<session_id>`, only when transcript_path is exactly
 *  `<projects-dir>/<session_id>.jsonl` and the id is a plain name. */
function sessionDir(facts: SpillFacts): string | undefined {
  const { transcriptPath, sessionId } = facts;
  if (transcriptPath === undefined || sessionId === undefined || !SAFE_ID.test(sessionId)) return undefined;
  if (basename(transcriptPath) !== `${sessionId}.jsonl`) return undefined;
  return join(dirname(transcriptPath), sessionId);
}

/** The calling agent's own transcript: its subagent file, or the main one
 *  for the session's own top-level seat. */
function transcriptOf(session: string, facts: SpillFacts): string | undefined {
  if (facts.agentId === undefined) return facts.topLevelSeat ? facts.transcriptPath : undefined;
  if (!SAFE_ID.test(facts.agentId)) return undefined;
  return join(session, "subagents", `agent-${facts.agentId}.jsonl`);
}

/** The file's first PREVIEW_PROOF_BYTES bytes as text. A multi-byte
 *  character cut at the end is dropped rather than compared as garbage. */
function fileHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(PREVIEW_PROOF_BYTES);
    const read = readSync(fd, buffer, 0, PREVIEW_PROOF_BYTES, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    return read === PREVIEW_PROOF_BYTES ? text.replace(/�+$/, "") : text;
  } finally {
    closeSync(fd);
  }
}

type Rec = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

function contentOf(record: Rec): readonly unknown[] {
  const message = record["message"];
  if (!isRecord(message)) return [];
  const content = message["content"];
  return Array.isArray(content) ? content : [];
}

/** A tool_result's text: a string, or the first of an array of text blocks. */
function resultText(block: Rec): string | undefined {
  const content = block["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  return isRecord(first) && first["type"] === "text" && typeof first["text"] === "string" ? first["text"] : undefined;
}

/** Whether a persisted-output text saves exactly `path` with `head` as its
 *  preview's start, read from its header lines and preview only. */
function provesSpill(text: string, path: string, head: string): boolean {
  const open = text.indexOf("\n");
  if (open === -1 || text.slice(0, open) !== HEADER_OPEN) return false;
  const savedEnd = text.indexOf("\n", open + 1);
  if (savedEnd === -1) return false;
  if (HEADER_SAVED.exec(text.slice(open + 1, savedEnd))?.[1] !== path) return false;
  const rest = text.slice(savedEnd);
  const leadIn = PREVIEW_LEAD_IN.exec(rest);
  return leadIn !== null && rest.slice(leadIn[0].length).startsWith(head);
}

/** Whether the transcript records this agent's own call saving `path` with
 *  `head` as the file's start; undefined when a line is not a JSON record.
 *  Only a final line with no newline yet, still being written, is skipped. */
export function recordsOwnSpill(transcript: string, path: string, head: string): boolean | undefined {
  const calls = new Set<string>();
  let owned = false;
  const lines = transcript.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) continue; // unterminated: not yet written in full
      return undefined;
    }
    if (!isRecord(record)) return undefined;
    for (const block of contentOf(record)) {
      if (!isRecord(block)) continue;
      if (record["type"] === "assistant" && block["type"] === "tool_use" && typeof block["id"] === "string") calls.add(block["id"]);
      if (record["type"] !== "user" || block["type"] !== "tool_result") continue;
      const id = block["tool_use_id"];
      if (typeof id !== "string" || !calls.has(id)) continue;
      const text = resultText(block);
      if (text !== undefined && provesSpill(text, path, head)) owned = true;
    }
  }
  return owned;
}
