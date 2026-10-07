#!/usr/bin/env bun
// The entry file Claude Code runs for every PreToolUse call. A bootstrap with
// no static imports: everything else is loaded inside the try, so a missing
// module or a syntax error is still a deny. It always exits 0; a crash that
// escaped would be read as "proceed". (When bun itself cannot start, the
// installed command's `|| exit 2` blocks the call instead.)
try {
  const [{ run }, { decideFromConfig }] = await Promise.all([import("./run.ts"), import("./composition-root.ts")]);
  await run(decideFromConfig);
} catch (thrown) {
  const reason = `bounded's Claude Code hook failed to start: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
  const redirect = "Report this to the maintainers of bounded; the call stays refused until it is fixed";
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${reason}\n${redirect}` } }));
}
process.exitCode = 0;
