// Hosts what the composition root returns: stdin in, the answer on stdout.
import { Verdict } from "bounded/domain";
import { composeHook } from "./composition-root.ts";
import { type Decide, FAILED, respond } from "./hook.ts";

export async function run(decide: Decide): Promise<void> {
  let answer: string;
  try {
    const hook = composeHook({ env: process.env, argv: process.argv.slice(2), decide });
    answer = await hook(await Bun.stdin.text());
  } catch (thrown) {
    answer = respond(Verdict.refuse(`bounded's Claude Code hook failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`, FAILED));
  }
  process.stdout.write(answer);
}
