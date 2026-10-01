// Claude Code discovery files for a project-local Bounded installation.
// The caller assembles the harness in a staging project before invoking this.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { SETUP_COMMAND } from "../../src/setup-state.ts";
import { DEV_STAGE_SKILL, mergeAmbientHook } from "./install.ts";
import { GENERATED_MARKER, hookFrontmatter, readPiAgent, renderAgent } from "./render-agents.ts";

/** The scout's Claude Code toolset: Read, and Bash for names-only listing
 *  (listing.ts; judged by lead-hook.ts). Pinned to the tools this host
 *  provides by render-agents.test.ts. */
export const SCOUT_CLAUDE_TOOLS: readonly string[] = ["Read", "Bash"];

function containedPath(target: string, path: string): string {
  const rel = relative(resolve(target), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("the copied harness must be inside the project");
  }
  return rel;
}

/** Install only Claude Code's project-local discovery files. The copied
 * harness remains the single source for skills, roles, hooks and gate code. */
export function installProjectClaude(target: string, harnessRoot: string): void {
  const relRoot = containedPath(target, harnessRoot);
  const hook = join(harnessRoot, "hosts", "claude-code", "bootstrap-hook.ts");
  const fullHook = join(harnessRoot, "hosts", "claude-code", "path-gate-hook.ts");
  const skill = join(harnessRoot, "skills", DEV_STAGE_SKILL);
  const leadSkill = join(harnessRoot, "skills", "team-lead");
  const scoutSource = join(harnessRoot, "agents", "scout.md");
  const gate = join(harnessRoot, "scripts", "bounded");
  const projectInstructions = join(target, "AGENTS.md");
  const claudeInstructions = join(target, "CLAUDE.md");
  if (existsSync(claudeInstructions)) throw new Error("Claude Code installation refuses an existing CLAUDE.md");
  for (const source of [hook, fullHook, join(skill, "SKILL.md"), join(leadSkill, "SKILL.md"), scoutSource, gate, projectInstructions]) {
    if (!existsSync(source)) throw new Error(`Claude Code installation requires ${source}`);
  }

  // Claude Code supplies CLAUDE_PROJECT_DIR even when a tool changes cwd.
  // Keep the stored command independent of both cwd and installer location.
  const relativeHook = join(relRoot, "hosts", "claude-code", "bootstrap-hook.ts")
    .replace(/[\\`"$]/g, "\\$&");
  const hookCommand = `node "\${CLAUDE_PROJECT_DIR}/${relativeHook}" --project-local`;
  const settingsPath = join(target, ".claude", "settings.json");
  let settings: Readonly<Record<string, unknown>> = {};
  if (existsSync(settingsPath)) {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Claude Code settings must be a JSON object");
    }
    settings = parsed as Readonly<Record<string, unknown>>;
  }
  const merged = mergeAmbientHook(settings, hookCommand);
  if (!merged.ok) throw new Error(`Claude Code settings: ${merged.reason}`);

  // Rendering reads role briefs from the project-local copy. No generated
  // definition refers to the installer checkout.
  const rendered = Object.fromEntries(
    PIPELINE_ROLES.map((role) => [role, renderAgent(role, { harnessRoot, hookCommand: `${hookCommand} --role ${role}` })]),
  ) as Record<(typeof PIPELINE_ROLES)[number], string>;
  // The scout's own hook binds it to the read-only scout policy, so the
  // project-wide hook can prove the child is judged and stand down.
  const scout = [
    "---",
    `${GENERATED_MARKER} from agents/scout.md`,
    "name: scout",
    "description: Read-only research subagent for the team lead.",
    `tools: ${SCOUT_CLAUDE_TOOLS.join(", ")}`,
    ...hookFrontmatter(`${hookCommand} --role scout`),
    "---",
    "",
    "## This host: Claude Code",
    "",
    "Read files with Read. List file names through Bash with `ls [<dir>]` or `find <dir> -name '<glob>'` (also `-iname`, `-path`, `-type f|d`, `-maxdepth N`), one plain command per call; Bash carries nothing else, and there is no content search on this host. List first, then read by the exact path — never guess a path. These are your entire toolset. Return findings to the lead in your final response; the pi `contact_supervisor` tool mentioned below is unavailable on this host.",
    "",
    "---",
    "",
    readPiAgent(harnessRoot, "scout").body,
    "",
  ].join("\n");

  const agentsDir = join(target, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const role of PIPELINE_ROLES) {
    writeFileSync(join(agentsDir, `${role}.md`), rendered[role]);
  }
  writeFileSync(join(agentsDir, "scout.md"), scout);
  const skillDest = join(target, ".claude", "skills", DEV_STAGE_SKILL);
  mkdirSync(join(target, ".claude", "skills"), { recursive: true });
  cpSync(skill, skillDest, { recursive: true, force: false, errorOnExist: true });
  cpSync(leadSkill, join(target, ".claude", "skills", "team-lead"), { recursive: true, force: false, errorOnExist: true });
  // The composed packs' skills (the layout, contract and stack guidance the
  // briefs name) are skills here too, as they are on pi; the copied harness
  // holds only the composed packs, so nothing uncomposed is installed.
  const packsDir = join(harnessRoot, "packs");
  for (const pack of existsSync(packsDir) ? readdirSync(packsDir).sort() : []) {
    const skills = join(packsDir, pack, "skills");
    if (!existsSync(skills)) continue;
    for (const name of readdirSync(skills).sort()) {
      if (!existsSync(join(skills, name, "SKILL.md"))) continue;
      cpSync(join(skills, name), join(target, ".claude", "skills", name), { recursive: true, force: false, errorOnExist: true });
    }
  }
  writeFileSync(settingsPath, JSON.stringify(merged.value, null, 2) + "\n");
  const leadInstructions = [
    "# Bounded project entry",
    "",
    "The main user-facing session starts each request as the read-only team lead. Load the team-lead skill automatically; the user never has to name a role or describe the workflow. Use the scout agent for read-only investigation. Keep user interaction in the main session. Subagents follow their own installed role definitions.",
    "",
    "Prepare each run with `bash .bounded/harness/scripts/bounded lead prepare`. Use `--new` when the user's request is a new work item after the prior one was delivered; omit it for a follow-up to the current item. For a new tracked issue, use `--new <ticket>`; otherwise let the command allocate a local number. Decide this from the request and project state; the user need not know the mechanics. Then delegate delivery to the architect as an ordinary unnamed foreground subagent. The architect runs the developer-stage skill and commissions its own reviewer, test-writer, and builder. Let each role's installed definition bind its tools and hook. Never implement the work as the lead.",
    "",
    `Before the first run, and whenever the entry reports that dependencies are not ready, run exactly \`${SETUP_COMMAND}\`. Until setup completes, the session can only read project files. Gate discovery is available through \`bash .bounded/harness/scripts/bounded gates --list\`.`,
    "",
    "---",
    "",
  ].join("\n");
  writeFileSync(claudeInstructions, leadInstructions + readFileSync(projectInstructions, "utf8"));
}
