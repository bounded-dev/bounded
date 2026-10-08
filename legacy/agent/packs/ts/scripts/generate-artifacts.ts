// The generate_artifacts gate (ADR 2026-055): run the deterministic
// generators the project's composed packs contribute through the
// artifactGenerators socket. It names no technology; a project that composes
// no generator runs none.
//
// Preconditions, in order, each a logged BLOCK:
//   · the project config is what the composed packs generate (ADR 2026-054):
//     generators execute project config (a Drizzle config, say), so they must
//     never run over config a role or a hand edit changed;
//   · the design is frozen: generators derive files from what the builder
//     writes, and the builder is commissioned only after design_gate's
//     freeze, so a call before it has nothing legitimate to derive from.
// Only the architect holds the tool (ROLE_TOOLS), on both hosts.
import { composedPacks } from "../../installed.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";
import type { GateResult } from "../../../src/gate-result.ts";
import { artifactGenerators } from "../pack.ts";
import { hasManifest } from "./checksum-gate.ts";
import { configDriftBlock } from "./project-config.ts";

export const GUARD = "generate-artifacts";

function blocked(cwd: string, summary: string, lines: readonly string[], detail: Record<string, unknown>): GateResult {
  logGuardEvent(cwd, { guard: GUARD, verdict: "block", summary, detail });
  return { code: 1, verdict: "block", summary, lines: [`${GUARD}: BLOCK — ${summary}`, ...lines], detail };
}

/** Run only the deterministic generators contributed by selected packs. */
export function runArtifactGenerators(cwd: string, harnessRoot?: string): GateResult {
  const configBlock = configDriftBlock(GUARD, cwd, harnessRoot);
  if (configBlock !== undefined) return configBlock;
  if (!hasManifest(cwd)) {
    return blocked(cwd, "no frozen design", [
      "  Generators derive files from what the builder writes, and the builder starts after design_gate freezes the design.",
      "  Run design_gate first, then call this after the builder changes a generator's input.",
      `${GUARD}: route → architect`,
    ], { step: "precondition", reason: "no-freeze", route: "architect" });
  }
  let current = "";
  try {
    const generators = composedPacks(cwd).read(artifactGenerators);
    const lines: string[] = [];
    for (const generator of generators) {
      current = generator.name;
      lines.push(...generator.run(cwd).map((line) => `${generator.name}: ${line}`));
    }
    const summary = generators.length === 0
      ? "no composed pack contributes an artifact generator"
      : `${generators.length} selected artifact generator(s) completed`;
    const detail = { generators: generators.map((generator) => generator.name) };
    logGuardEvent(cwd, { guard: GUARD, verdict: "pass", summary, detail });
    return { code: 0, verdict: "pass", summary, lines: [`${GUARD}: ${summary}`, ...lines], detail };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000);
    const summary = current ? `${current}: ${message}` : message;
    return blocked(cwd, summary, [
      "  Nothing after the failing generator ran. Review what it reports; a correction to its input is the builder's.",
      `${GUARD}: route → architect`,
    ], { step: "generator", generator: current || undefined, route: "architect" });
  }
}
