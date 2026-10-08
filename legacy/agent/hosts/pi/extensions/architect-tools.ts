/**
 * Architect tools (issue #12): the gates, and git.
 *
 * The architect drives a whole ticket but holds NO `bash` — a shell defeats
 * every path rule at once, so it gets named tools for the things it
 * legitimately needs instead of a way to run anything. This file is what makes
 * that trade survivable: every capability the architect actually needs exists
 * here, or it cannot do its job.
 *
 * The gate tools are not written here. They come from the gate registry
 * (`packs/ts/gates.ts`, ADR 2026-034) through `lib/gate-tools.ts`: one entry
 * per gate carries the name, description, flags and prompt guidance, and this
 * extension only says WHICH entries the architect holds — `GATE_TOOLS` from
 * the path policy, plus `mutation_score`. `bounded gates` reads the same entries
 * for its command line, so a gate cannot differ by how it was invoked. That
 * matters more than it sounds: "the architect runs every gate itself and
 * never trusts a worker's word" is worth nothing if the tool is a second,
 * drifting implementation of the gate — and before the registry, the verdict
 * line, the cwd rule and the descriptions were exactly such copies.
 *
 * Two things the named tools buy beyond closing the shell:
 *
 *   · The invocation guidance deletes itself. Dogfood Run 4's orchestrator
 *     spent its first ~3 minutes `find`-ing the pack and `head`-ing three gate
 *     scripts to work out how to call them, then re-read two of them mid-run.
 *     A tool schema cannot be mis-invoked that way, and `design_gate` finds
 *     the contracts itself rather than taking one path per call.
 *   · Every gate lands in the guard log by construction, so "did the architect
 *     actually run the gate" is checkable rather than trusted.
 *
 * The roster is deliberately not one tool per gate script. Where several gates
 * have exactly one legal order, they are one tool: `design_gate` is
 * purity → scaffold → typecheck → design-review → freeze in a single call with
 * a single verdict (ADR 2026-019, ADR 2026-020), because the order used to live
 * in prose and prose executes unreliably. `contract_purity` survives alongside it as the cheap
 * single check while a contract is still being iterated on.
 *
 * Two of the tools here are not gates and decide nothing.
 *
 *   · `sleep` exists because r15's architect had no way to pass time. Its
 *     reviewer stalled, and with a stalled child, no wait primitive and a
 *     standing instruction not to busy-loop, it reached for the only thing
 *     that blocked: it ran `design_gate` five times as a clock, writing four
 *     junk scaffolds, and said so out loud — "Since I have no sleep mechanism
 *     and shouldn't busy-loop, calling design_gate itself serves as a
 *     legitimate poll". A gate run is a claim about the project's state, so a
 *     run made to fill a gap corrupts the only record of what happened. The
 *     fix is not a paragraph asking it to stop; it is a primitive that waits.
 *     It is a host utility, not an artifact gate, so it is written here.
 *   · `mutation_score` exists because both r15 arms' surviving mutants mapped
 *     exactly onto their prompts' headline rules — the measurement was
 *     available and nobody could run it. It is advisory by construction
 *     (exit 0 means it ran, whatever the score), so it never blocks a phase;
 *     it is here so the architect can take the measurement before it signs
 *     off rather than after the run is over. It inspects the tree, so it is
 *     a registry entry like the gates.
 *
 * Git is read-only here. A mutating command can rewrite a protected file
 * without passing through the file-tool path gate. The shared policy applies
 * to this named tool and to Claude Code's Bash carrier alike.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { gates } from "../../../packs/ts/gates.ts";
import { gitPolicy } from "../../../src/git-policy.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";
import { GATE_TOOLS } from "../../../src/path-policy.ts";
import { targetCwd } from "../../../src/target-cwd.ts";
import { cwdParam, registerGateTools } from "./lib/gate-tools.ts";
import { SLEEP_MAX_SECONDS, SLEEP_MIN_SECONDS, clampSleepSeconds } from "../../../src/sleep-bounds.ts";

export default function (pi: ExtensionAPI): void {
  registerGateTools(pi, gates, new Set([...GATE_TOOLS, "mutation_score"]));

  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    description:
      "Wait, doing nothing, for `seconds` (1-120), then return. This is the ONLY way to pass time, and it exists so that waiting out a working subagent costs a wait instead of a junk gate run. Between `subagent { action: \"status\" }` polls on a child that is still working, call this. NEVER call a gate to pass time: a gate run is a claim about the project's state, and one made to fill a gap corrupts the only record of what actually happened.",
    promptSnippet: "Wait a few seconds for a working subagent, without polling a gate.",
    promptGuidelines: [
      "The poll loop is: `subagent { action: \"status\", id }`, then sleep, then status again. 30-60s is the useful interval for a worker mid-task; anything under 5s spends a turn to learn nothing.",
      "Prefer `subagent_wait` when you hold it and the child is a live async run — it returns the moment the child is done rather than at the end of a fixed interval. Reach for sleep when there is nothing to wait ON: a stalled child, a poll you want to space out, a retry you want to delay.",
      "It is never a substitute for doing work. If there is design or arbitration you could be doing while a worker runs, do that instead.",
    ],
    parameters: Type.Object({
      seconds: Type.Number({
        minimum: 1,
        maximum: 120,
        description: "How long to wait, in seconds. 1-120; values outside that range are clamped.",
      }),
      cwd: cwdParam(),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const seconds = clampSleepSeconds(params.seconds);
      const waited = await sleepSeconds(seconds, signal);
      // Logged so a run's story shows the wait rather than a gap. Without this
      // line "the architect waited two minutes" and "the architect did nothing
      // for two minutes" are the same absence in the transcript.
      logGuardEvent(cwd, {
        guard: "sleep",
        verdict: "pass",
        summary: `waited ${waited}s`,
        detail: { seconds: waited, requested: params.seconds },
      });
      return {
        content: [{ type: "text" as const, text: `sleep: waited ${waited}s` }],
        details: { code: 0, ok: true, seconds: waited },
      };
    },
  });

  pi.registerTool({
    name: "git",
    label: "Git",
    description:
      "Inspect Git history and status with read-only commands. Args are passed as an array, exactly as git would receive them: [\"log\", \"--oneline\", \"-10\"]. Mutating commands are refused because they bypass file path guards.",
    promptSnippet: "Inspect Git with a read-only command (args as an array).",
    promptGuidelines: [
      "Pass args as an array, not a shell string: [\"commit\", \"-m\", \"message\"] — there is no shell, so quoting and pipes do not apply.",
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description:
          'Git arguments as an array, e.g. ["status", "--short"] or ["show", "abc123:path/to/file.ts"].',
      }),
      cwd: cwdParam(),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const refused = gitPolicy(params.args);
      if (refused !== undefined) {
        logGuardEvent(cwd, { guard: "git", verdict: "block", summary: refused, detail: { args: params.args } });
        return { content: [{ type: "text" as const, text: `git: ${refused}` }], details: { code: 1, ok: false } };
      }
      const { code, stdout, stderr } = await runGit(params.args, cwd, signal);
      logGuardEvent(cwd, {
        guard: "git",
        verdict: code === 0 ? "pass" : "block",
        summary: `git ${params.args.join(" ")} → exit ${code}`,
        detail: { args: params.args, code },
      });
      const text = [stdout, stderr].filter((s) => s.trim() !== "").join("\n") || `(exit ${code})`;
      return { content: [{ type: "text" as const, text }], details: { code, ok: code === 0 } };
    },
  });
}

/** Spawn git directly — no shell, so this tool is never itself an injection point. */
function runGit(
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...args], { cwd, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/** The `sleep` tool's bounds, applied rather than refused: a wait that is a
 *  little too long is not worth costing the architect a turn to re-issue. */
export {
  SLEEP_MAX_SECONDS,
  SLEEP_MIN_SECONDS,
  clampSleepSeconds,
} from "../../../src/sleep-bounds.ts";

/** Wait `seconds`, returning early (and reporting the truth) if aborted. */
function sleepSeconds(seconds: number, signal?: AbortSignal): Promise<number> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolvePromise(Math.round((Date.now() - started) / 1000));
    };
    const timer = setTimeout(done, seconds * 1000);
    signal?.addEventListener("abort", done, { once: true });
  });
}
