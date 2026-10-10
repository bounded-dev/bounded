// The prereqs status band (ADR 2026-027): a Claude Code plugin that draws
// bounded/prereqs's status above the prompt, from the status file bounded's
// own hook writes after each finished tool call and agent run
// (.bounded/prereqs/status.json, ADR 2026-026). It decides nothing and holds
// no phase: it keeps one value, when it last saw a finish, so it never shows
// a reading older than that as current. Every hook has a .catch: a band that
// fails never changes or blocks an event, and draws "unavailable", never a
// stale status. Every use of $ is in this file (the engine allows $ to be
// passed only to functions declared here); the modules it imports are pure.
import type { AbovePromptFields, BandEngine, On } from "./engine-subset";
import { drawFailedLines, missingFileLines, otherProjectLines, READING_WAIT_MS, statusLines, unreadableLines } from "./prereqs-status-band-lines";
import { readStatusFile, STATUS_FILE } from "./prereqs-status-file";
import { PROJECT_CONFIG_NAMES } from "./project-config-names";

/** The band's one value: when it last saw a finished tool call or agent run, from $.clock.now(). */
const LAST_FINISH_SEEN_AT = { plugin: "bounded-prereqs-status-band", key: "lastFinishSeenAt" } as const;
/** How often the band draws itself again, so "updating" turns into "unavailable" and a late file is found. */
const REDRAW_EVERY_MS = 2_000;
/** How many times a mark is tried when another finish's mark lands in between. */
const MARK_ATTEMPTS = 5;

/** Whether this environment's redraw timer runs: it dies with the environment (a reload), and so does this. */
let redrawing = false;

/** Starts the 2-second redraw, once per environment. */
function startRedraw<Element>($: BandEngine<Element>): void {
  if (redrawing) return;
  redrawing = true;
  $.clock.every(REDRAW_EVERY_MS, () => $.ui.invalidate("ui.render"));
}

/**
 * Marks a finish: the mark only moves forward. The time is read once; the
 * mark is written only while it stands at the version read, and read again
 * when another write landed first, so two finishes whose writes land out of
 * order leave the later time.
 */
async function markFinish<Element>($: BandEngine<Element>): Promise<void> {
  const now = await $.clock.now();
  for (let attempt = 0; attempt < MARK_ATTEMPTS; attempt += 1) {
    const held = await $.state.get(LAST_FINISH_SEEN_AT);
    if (typeof held.value === "number" && held.value >= now) return;
    const written = await $.state.set(LAST_FINISH_SEEN_AT, now, { ifVersion: held.version });
    if (written.isSet) break;
  }
  // Drawn again the moment the wait for its reading ends, so "updating" turns into "unavailable" then, not at the next 2-second redraw.
  $.clock.after(READING_WAIT_MS + 1, () => $.ui.invalidate("ui.render"));
}

/** Where `path` lands, every link resolved; undefined when it leads nowhere. */
async function realPathOf<Element>($: BandEngine<Element>, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath;
  } catch {
    return undefined;
  }
}

/** Whether the session's root holds a bounded configuration. */
async function hasConfig<Element>($: BandEngine<Element>, root: string): Promise<boolean> {
  for (const name of PROJECT_CONFIG_NAMES) if (await $.fs.exists(`${root}/${name}`)) return true;
  return false;
}

/** The band's lines for the project at `root`: the status file read, refused, or not there. */
async function linesFor<Element>($: BandEngine<Element>, root: string): Promise<string[]> {
  const path = `${root}/${STATUS_FILE}`;
  if (!(await $.fs.exists(path))) return missingFileLines();
  let text: string;
  try {
    text = await $.fs.read(path);
  } catch (thrown) {
    return unreadableLines(thrown instanceof Error ? thrown.message : String(thrown));
  }
  const reading = readStatusFile(text);
  if (reading.ok) {
    const sessionRoot = await realPathOf($, root);
    const projectRoot = await realPathOf($, reading.value.projectRoot);
    if (sessionRoot === undefined || projectRoot === undefined || sessionRoot !== projectRoot) return otherProjectLines(reading.value.projectRoot, root);
  }
  const held = await $.state.get(LAST_FINISH_SEEN_AT);
  return statusLines(reading, { lastFinishSeenAt: held.value, now: await $.clock.now() });
}

/** The band's tree: one truncated line of text per line. */
function draw<Element>($: BandEngine<Element>, e: AbovePromptFields, lines: readonly string[]): Element {
  const { Box, Text } = $.ui.resolve(e);
  return Box({ flexDirection: "column", children: lines.map((line) => Text({ wrap: "truncate-end", children: line })) });
}

export function register(on: On): void {
  on("session.start", async ($, e, next) => {
    startRedraw($);
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("classic.PostToolUse", async ($, e, next) => {
    startRedraw($);
    await markFinish($);
    const answer = await next(e);
    $.ui.invalidate("ui.render");
    return answer;
  }).catch((_$, e, next) => next(e));

  on("classic.PostToolUseFailure", async ($, e, next) => {
    startRedraw($);
    await markFinish($);
    const answer = await next(e);
    $.ui.invalidate("ui.render");
    return answer;
  }).catch((_$, e, next) => next(e));

  // A finish with an empty agent_type names no agent a rule can require, and bounded's hook records nothing for it.
  on("classic.SubagentStop", async ($, e, next) => {
    startRedraw($);
    if (e.agent_type !== "") await markFinish($);
    const answer = await next(e);
    $.ui.invalidate("ui.render");
    return answer;
  }).catch((_$, e, next) => next(e));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const root = await $.session.root();
    if (!(await hasConfig($, root))) return next(e);
    return draw($, e, await linesFor($, root));
  }).catch(($, e, next) => {
    try {
      return draw($, e, drawFailedLines(next.error.message ?? next.error.kind));
    } catch {
      return undefined;
    }
  });
}
