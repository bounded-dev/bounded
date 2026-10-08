/**
 * Developer-stage worker tools (TN-26-001, §"Custom tools" #3).
 *
 * The tools the non-architect roles get in place of `bash`. None of them is
 * held by every role: the frontmatter allowlist decides who holds what, and
 * `ROLE_TOOLS` in src/path-policy.ts is the canonical statement of that (the
 * path gate refuses the ones that are one role's alone, as a backup layer).
 *
 *   remove(path, cwd?)      — delete one file, inside the caller's write zones.
 *   run_tests(cwd?)         — BUILDER ONLY. Runs the project's test suite
 *                             through the composed pack's gate and returns ONLY sanitized
 *                             results (failure names + assertion diffs; no code
 *                             frames, stacks, paths, or console).
 *   typecheck(cwd?)         — runs the composed pack's type check; returns pass/fail +
 *                             diagnostics with absolute machine paths redacted
 *                             AND scoped to the calling role: a worker sees its
 *                             own zone and the shared interface in full, and
 *                             another role's errors as a count plus an owner.
 *                             Same blindness run_tests already enforces; the
 *                             role comes from the path gate's own binding, and
 *                             the tool exposes no way to claim another.
 *   record_design_review    — REVIEWER ONLY. Records the pre-freeze review of
 *     (findings, cwd?)        spec + contracts in the guard log, checksum-bound
 *                             to the bytes reviewed. The reviewer has no write
 *                             zone at all, so this is the only mark it leaves.
 *
 * Only `remove` is written here: it is a host tool (the path gate vets it),
 * not an artifact gate. The other three are gate-registry entries
 * (`packs/ts/gates.ts`, ADR LEG-2026-034) registered through `lib/gate-tools.ts`,
 * so their names, descriptions, parameters, guard events and verdict lines are
 * the same ones `bounded gates` serves from a shell — this file says only which
 * entries the worker roles hold. A normal session holds none of these agents'
 * allowlists and simply never calls them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstatSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { gates } from "../../../packs/ts/gates.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";
import { targetCwd } from "../../../src/target-cwd.ts";
import { registerGateTools } from "./lib/gate-tools.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "remove",
    label: "Remove File",
    description:
      "Delete one file. Subject to the same write zones as write/edit — you can only remove files you could have written. Directories are refused.",
    promptSnippet: "Delete a file inside your write zones.",
    parameters: Type.Object({
      path: Type.String({ description: "File to delete (relative to the project root, or absolute)." }),
      cwd: Type.Optional(Type.String({ description: "Project root override." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // The path gate has already vetoed out-of-zone paths before this runs;
      // what remains is mechanics. Deleting a directory is refused because no
      // role's job ever requires it — a recursive delete is a blast radius, not
      // a capability.
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const target = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);
      let st;
      try {
        st = lstatSync(target);
      } catch {
        return { content: [{ type: "text" as const, text: `remove: '${params.path}' does not exist (nothing to do)` }], details: { ok: true, existed: false } };
      }
      if (st.isDirectory()) {
        return { content: [{ type: "text" as const, text: `remove: '${params.path}' is a directory — remove refuses directories; delete files one by one` }], details: { ok: false } };
      }
      rmSync(target);
      logGuardEvent(cwd, { guard: "remove", verdict: "pass", summary: `removed ${params.path}`, detail: { path: params.path } });
      return { content: [{ type: "text" as const, text: `remove: deleted ${params.path}` }], details: { ok: true, existed: true } };
    },
  });

  registerGateTools(pi, gates, new Set(["run_tests", "typecheck", "record_design_review", "change_diff"]));
}
