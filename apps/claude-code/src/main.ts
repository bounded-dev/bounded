#!/usr/bin/env bun
// The entry file: Claude Code runs it for every PreToolUse call, with the
// call's JSON on stdin. It hosts what the composition root returns and
// always exits 0: a non-zero exit would not block the call.
import { Verdict } from "bounded/domain";
import { composeHook, decideFromConfig } from "./composition-root.ts";
import { type Decide, respond } from "./hook.ts";

export async function main(decide: Decide): Promise<void> {
  let answer: string;
  try {
    const hook = composeHook({ env: process.env, argv: process.argv.slice(2), decide });
    answer = hook(await Bun.stdin.text());
  } catch (thrown) {
    answer = respond(Verdict.refuse(`bounded's Claude Code hook failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`, "Report this to the maintainers of bounded"));
  }
  process.stdout.write(answer);
  process.exitCode = 0;
}

if (import.meta.main) await main(decideFromConfig);
