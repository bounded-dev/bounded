// Install the Claude Code host adapter into a project (ADR 2026-034).
//
//   node install.ts <targetDir> [--harness-root <dir>]
//
// Writes the four developer-stage subagent definitions to <target>/.claude/agents/,
// links the developer-stage skill into <target>/.claude/skills/ (the
// architect's brief opens by loading it, and Claude Code reads skills from
// the project's .claude/skills, not from ~/.pi/agent/skills), and merges the
// ambient path-gate hook into <target>/.claude/settings.json. Idempotent: a
// second run changes nothing and says so per file.
//
// Three things it refuses to do, loudly, because each would be a silent loss:
//   · overwrite an agent file that does not carry the generated marker — that
//     is someone's hand-written definition, not an older render of ours;
//   · replace a real `.claude/skills/developer-stage` directory that is not
//     our own copy (no marker file inside) — that is someone's skill;
//   · rewrite a settings.json it cannot parse, or one whose `hooks.PreToolUse`
//     is not a list. Other keys are never dropped; our entry is added once,
//     recognised by its command naming path-gate-hook.ts.
//
// Exit 0 done · 1 refused (nothing partial: every destination is checked
// before any is written) · 2 usage.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isMainModule } from "../../src/is-main-module.ts";
import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { defaultHarnessRoot, GENERATED_MARKER, hookCommandFor, isGenerated, renderAllAgents } from "./render-agents.ts";

export const AGENTS_DIR = join(".claude", "agents");
export const SETTINGS_FILE = join(".claude", "settings.json");
/** Where Claude Code reads a project's skills; the developer-stage skill is
 *  linked here from `<harnessRoot>/skills/developer-stage`. */
export const SKILLS_DIR = join(".claude", "skills");
export const DEV_STAGE_SKILL = "developer-stage";
/** Written inside a COPIED skill directory (symlink refused by the platform),
 *  so a later run knows the copy is ours to refresh. */
export const SKILL_COPY_MARKER = ".bounded-harness-generated";

/** What identifies our entry in settings.json, whatever path it was installed from. */
const HOOK_SCRIPT_NAMES = ["path-gate-hook.ts", "bootstrap-hook.ts"] as const;
const FOREGROUND_AGENTS_ENV = "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS";
const AGENT_TEAMS_ENV = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS";

type Json = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export type Merge =
  | { readonly ok: true; readonly value: Json; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Add the ambient hook and run pipeline roles in the foreground. Claude Code's
 * interactive fork mode otherwise forces Agent calls into the background, so
 * the architect cannot await a reviewer before freezing the design. Preserve
 * unrelated settings and refuse conflicting env values. Keep agent teams off
 * so a named nested Agent call stays an ordinary subagent.
 */
export function mergeAmbientHook(settings: Json, command: string): Merge {
  const envRaw = settings["env"];
  if (envRaw !== undefined && !isRecord(envRaw)) return { ok: false, reason: "'env' is not an object" };
  const env: Json = envRaw ?? {};
  const foreground = env[FOREGROUND_AGENTS_ENV];
  if (foreground !== undefined && foreground !== "1") {
    return { ok: false, reason: `'env.${FOREGROUND_AGENTS_ENV}' conflicts with the developer-stage workflow` };
  }
  const teams = env[AGENT_TEAMS_ENV];
  if (teams !== undefined && teams !== "0") {
    return { ok: false, reason: `'env.${AGENT_TEAMS_ENV}' conflicts with ordinary nested agent delegation` };
  }
  const hooksRaw = settings["hooks"];
  if (hooksRaw !== undefined && !isRecord(hooksRaw)) return { ok: false, reason: "'hooks' is not an object" };
  const hooks: Json = hooksRaw ?? {};
  const merged: Record<string, unknown> = { ...hooks };
  let added = false;
  for (const [event, matcher] of AMBIENT_HOOK_EVENTS) {
    const raw = hooks[event];
    if (raw !== undefined && !Array.isArray(raw)) return { ok: false, reason: `'hooks.${event}' is not a list` };
    const list: readonly unknown[] = raw ?? [];
    if (list.some(isOurHook)) continue;
    merged[event] = [...list, { matcher, hooks: [{ type: "command", command }] }];
    added = true;
  }
  if (!added && foreground === "1" && teams === "0") return { ok: true, value: settings, changed: false };
  return {
    ok: true,
    changed: true,
    value: {
      ...settings,
      env: { ...env, [FOREGROUND_AGENTS_ENV]: "1", [AGENT_TEAMS_ENV]: "0" },
      hooks: merged,
    },
  };
}

/**
 * The events the project-wide hook runs on. Before every call it decides;
 * after an Agent call it only records — that is how the lead's architect is
 * known to have ended (or not), so a second architect is never started while
 * one runs (lead-hook.ts).
 */
export const AMBIENT_HOOK_EVENTS: readonly (readonly [string, string])[] = [
  ["PreToolUse", ""],
  ["PostToolUse", "Agent|Task"],
  ["PostToolUseFailure", "Agent|Task"],
];

function isOurHook(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const inner = entry["hooks"];
  return (
    Array.isArray(inner) &&
    inner.some((h) => {
      if (!isRecord(h)) return false;
      const command = h["command"];
      return typeof command === "string" && HOOK_SCRIPT_NAMES.some((name) => command.includes(name));
    })
  );
}

function usage(): number {
  process.stderr.write("usage: node install.ts <targetDir> [--harness-root <dir>]\n");
  return 2;
}

/** Write only when the bytes differ, and say which happened. */
function put(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    process.stdout.write(`unchanged ${path}\n`);
    return;
  }
  writeFileSync(path, content);
  process.stdout.write(`wrote ${path}\n`);
}

/** What the skill destination is right now. */
type SkillState =
  | { readonly kind: "absent" }
  | { readonly kind: "linked"; readonly target: string }
  | { readonly kind: "our-copy" }
  | { readonly kind: "foreign" };

function skillState(dest: string): SkillState {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dest);
  } catch {
    return { kind: "absent" };
  }
  if (st.isSymbolicLink()) return { kind: "linked", target: readlinkSync(dest) };
  if (st.isDirectory() && existsSync(join(dest, SKILL_COPY_MARKER))) return { kind: "our-copy" };
  return { kind: "foreign" };
}

/**
 * Link `<harnessRoot>/skills/developer-stage` at `<target>/.claude/skills/
 * developer-stage`. A symlink first — the skill then tracks the harness — and
 * a copy, with a marker file, only where the platform refuses the link. The
 * caller has already checked the destination is ours or absent.
 */
function linkSkill(source: string, dest: string): void {
  const state = skillState(dest);
  if (state.kind === "linked" && resolve(dest, "..", state.target) === source) {
    process.stdout.write(`unchanged ${dest}\n`);
    return;
  }
  mkdirSync(join(dest, ".."), { recursive: true });
  if (state.kind === "linked") unlinkSync(dest);
  if (state.kind === "our-copy") rmSync(dest, { recursive: true, force: true });
  try {
    symlinkSync(source, dest, "dir");
    process.stdout.write(`linked ${dest} -> ${source}\n`);
  } catch (err) {
    cpSync(source, dest, { recursive: true });
    writeFileSync(join(dest, SKILL_COPY_MARKER), `${GENERATED_MARKER} from ${source}\n`);
    process.stdout.write(
      `copied ${dest} (symlink refused: ${err instanceof Error ? err.message : String(err)}; re-run install.ts after editing the skill)\n`,
    );
  }
}

export function main(argv: readonly string[]): number {
  let target: string | undefined;
  let harnessRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--harness-root") {
      if (i + 1 >= argv.length) return usage();
      harnessRoot = argv[i + 1];
      i++;
    } else if (arg.startsWith("--")) return usage();
    else if (target === undefined) target = arg;
    else return usage();
  }
  if (target === undefined || harnessRoot === "") return usage();
  try {
    if (!statSync(target).isDirectory()) return usage();
  } catch {
    process.stderr.write(`install: ${target} is not a directory\n`);
    return 2;
  }
  const root = harnessRoot ?? defaultHarnessRoot();

  // Render first, check every destination, then write: a refusal leaves the
  // project exactly as it was.
  const rendered = renderAllAgents({ harnessRoot: root });
  const agentsDir = join(target, AGENTS_DIR);
  let refused = 0;
  for (const role of PIPELINE_ROLES) {
    const path = join(agentsDir, `${role}.md`);
    if (existsSync(path) && !isGenerated(readFileSync(path, "utf8"))) {
      process.stderr.write(
        `refused ${path}: not generated by bounded-harness (no "# generated by bounded-harness" line) — move it aside first\n`,
      );
      refused++;
    }
  }

  const skillSource = resolve(root, "skills", DEV_STAGE_SKILL);
  const skillDest = join(target, SKILLS_DIR, DEV_STAGE_SKILL);
  if (!existsSync(join(skillSource, "SKILL.md"))) {
    process.stderr.write(`refused: no ${DEV_STAGE_SKILL} skill under ${root} (expected ${join(skillSource, "SKILL.md")})\n`);
    return 1;
  }
  if (skillState(skillDest).kind === "foreign") {
    process.stderr.write(
      `refused ${skillDest}: not a symlink and carries no ${SKILL_COPY_MARKER} marker — someone's own skill; move it aside first\n`,
    );
    refused++;
  }

  const settingsPath = join(target, SETTINGS_FILE);
  let settings: Json = {};
  if (existsSync(settingsPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (err) {
      process.stderr.write(`refused ${settingsPath}: not valid JSON (${err instanceof Error ? err.message : String(err)})\n`);
      return 1;
    }
    if (!isRecord(parsed)) {
      process.stderr.write(`refused ${settingsPath}: not a JSON object\n`);
      return 1;
    }
    settings = parsed;
  }
  const merged = mergeAmbientHook(settings, hookCommandFor(root));
  if (!merged.ok) {
    process.stderr.write(`refused ${settingsPath}: ${merged.reason}\n`);
    return 1;
  }
  if (refused > 0) return 1;

  mkdirSync(agentsDir, { recursive: true });
  for (const role of PIPELINE_ROLES) put(join(agentsDir, `${role}.md`), rendered[role]);
  linkSkill(skillSource, skillDest);
  put(settingsPath, JSON.stringify(merged.value, null, 2) + "\n");
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
