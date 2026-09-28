import { composedPacks } from "../../installed.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";
import type { GateResult } from "../../../src/gate-result.ts";
import { artifactGenerators } from "../pack.ts";

const NAME = "generate-artifacts";

/** Run only the deterministic generators contributed by selected packs. */
export function runArtifactGenerators(cwd: string): GateResult {
  try {
    const generators = composedPacks(cwd).read(artifactGenerators);
    const lines = generators.flatMap((generator) =>
      generator.run(cwd).map((line) => `${generator.name}: ${line}`));
    const summary = `${generators.length} selected artifact generator(s) completed`;
    logGuardEvent(cwd, { guard: NAME, verdict: "pass", summary });
    return { code: 0, verdict: "pass", summary, lines: [`${NAME}: ${summary}`, ...lines], detail: { generators: generators.map((generator) => generator.name) } };
  } catch (error) {
    const message = error instanceof Error && "stderr" in error
      ? String((error as Error & { stderr?: Buffer | string }).stderr ?? error.message)
      : error instanceof Error ? error.message : String(error);
    const summary = message.trim().slice(0, 4000);
    logGuardEvent(cwd, { guard: NAME, verdict: "block", summary });
    return { code: 1, verdict: "block", summary, lines: [`${NAME}: ${summary}`], detail: {} };
  }
}
