// Hosts what the composition root returns: stdin in, the answer on stdout.
import { Verdict } from "bounded/domain";
import { composeHook, DEADLINE_MS, DRAIN_MS } from "./composition-root.ts";
import { type Decide, FAILED, respond } from "./hook.ts";
import type { Wiring } from "./composition-root.ts";

export interface Timing {
  readonly deadlineMs?: number;
  readonly drainMs?: number;
}

/** All of stdin as text, with node's streams: the hook runs under node, with no bun (ADR 2026-016). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Answers one call. The process is then left to drain, so work still pending
 * (the Bounded log's follow-up line) can finish, but for at most `drainMs`:
 * after that it exits, so nothing outlasts Claude Code's timeout for the hook.
 */
export async function run(decide: Decide, { deadlineMs = DEADLINE_MS, drainMs = DRAIN_MS }: Timing = {}, extras: Pick<Wiring, "afterTool" | "record" | "recordAgentRunFinish"> = {}): Promise<void> {
  let answer: string;
  try {
    const hook = composeHook({ ...extras, env: process.env, argv: process.argv.slice(2), decide, deadlineMs });
    answer = await hook(await readStdin());
  } catch (thrown) {
    answer = respond(Verdict.refuse(`bounded's Claude Code hook failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`, FAILED));
  }
  process.stdout.write(answer);
  process.exitCode = 0;
  setTimeout(() => process.exit(process.exitCode ?? 0), drainMs).unref();
}
