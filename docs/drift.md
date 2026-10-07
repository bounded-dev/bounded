# Drift: undoing what shell commands change

A guard judges a tool call from its effects, but a shell command's effects
cannot be read from its text: `./regenerate.sh` may rewrite files the path
gate protects. So the core checks protected files around every allowed shell
command and undoes any change.

## Watched paths

Packs and projects contribute to the core pack's `watchedPaths` point: files
a shell command must not change.

```ts
contribution(corePack.points.watchedPaths, [
  { match: "generated/**", except: ["generated/README.md"], why: "generated/ is written by the generator", redirect: "Change the generator's input instead" },
]);
```

`match` and `except` are project-relative globs; a file is watched by the
first rule that matches it and does not except it.

## Before and after

1. **Before** an allowed tool call with an `execute` effect, the judge hashes
   every watched file and keeps the hashes under the call's id (in
   `.bounded/snapshots/`, because a host may run each hook as its own
   process). If the files cannot be hashed, or the call has no `callId`, the
   command is refused.
2. **After** the call, the host passes its result to `afterTool`. The judge
   hashes again and, for any file that was modified, deleted or created,
   restores it from the last git commit (removing files git never held),
   checks the files now match the snapshot, records a refusal in the
   decision log (note "changed by a shell command; restored") and returns a
   message for the agent:

   > This command changed protected files, and they were restored:
   > generated/a.ts was modified. generated/ is written by the generator.
   > Instead: Change the generator's input instead.

If restoring fails, or leaves a file different from before the command (it
had changes git does not hold), the message says restoring FAILED and asks
for the files to be restored by hand, and the record notes it.

## For host adapters

- Pass the host's call id as `callId` on the tool use and its result.
- Call `judge(toolUse)` before the call and `afterTool(toolResult)` after it
  (Claude Code: PreToolUse and PostToolUse; pi: tool_call and tool_result),
  and show `message` to the agent when it is not null.
- Let the event loop drain after answering, so records are not lost.

## Limits

The check covers watched files only, restores to the last commit (not to
uncommitted work, which is reported instead), and runs after the command, so a
command can still read or send protected content while it runs.
