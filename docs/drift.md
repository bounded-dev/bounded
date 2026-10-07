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
first rule that matches it and does not except it. `match` ignores case, as
the path gate's does, so a file cannot be dodged by its case on a
case-insensitive file system; `except` is exact. `.git/` and `.bounded/` are
never watched.

## Before and after

1. **Before** an allowed tool call with an `execute` effect, the judge
   snapshots every watched file under the call's id: its SHA-256, its size,
   and how to put it back. A file that matches the checked-out commit is
   kept by reference to that commit; one that differs from it, or that git
   does not hold, is copied into the snapshot (up to 1 MB a file and 10 MB in
   all); a file beyond those limits is kept by its hash alone. If the files
   cannot be read, or the call has no `callId`, the command is refused.
2. **After** the call, the host passes its result to `afterTool`. The judge
   checks the snapshot, hashes again and puts back every file that was
   modified, deleted or created: from its copy, from the commit it matched,
   or by removing it when it did not exist before. It checks the files now
   match the snapshot, records a refusal in the decision log (note "changed
   by a shell command; restored") and returns a message for the agent:

   > This command changed protected files, and they were restored:
   > generated/a.ts was modified. generated/ is written by the generator.
   > Change the generator's input instead.

So uncommitted work in a watched file, and a watched file git does not hold,
come back as they were before the command. A file too large to copy that the
command changed is never replaced with another version: the message says
restoring FAILED, names it, and asks for it to be restored by hand, and the
record notes it ("restore failed"). So does any restore that fails.

## Snapshots, and what if one is tampered with

Hooks may run as separate processes, so snapshots are files, kept out of the
project in the user's state directory:
`$XDG_STATE_HOME/bounded/<sha256 of the project root>/snapshots/` (or
`~/.local/state/…` when `XDG_STATE_HOME` is unset or relative), one file per
call, directories 0700 and files 0600. A snapshot older than a day is never
used and is swept away whenever another is saved, so calls whose result never
came (the host denied them after bounded allowed them) leave nothing behind
for long.

Moving snapshots out of the project means a command's relative paths do not
reach them, but anything running as the same user still can. The real control
is detection: before a snapshot is trusted, its form, every hash, every copy
(against its hash) and every file kept by reference (against the commit) are
checked. A shell command's result whose snapshot is unreadable, malformed or
altered is reported against the last commit and recorded (note "snapshot
missing or altered"), and nothing is restored, since the command's changes
can no longer be told from earlier work:

> The snapshot for this command was missing or altered (generated/a.ts does
> not match the commit it was kept by), so its changes cannot be told from
> earlier work and nothing was restored. Protected files that differ from the
> last commit: generated/a.ts was modified. … Check them against version
> control.

A snapshot that is simply missing (deleted, or expired) is treated the same
way, but says nothing when no watched file differs from the last commit.
Every failure while checking is recorded too.

## For host adapters

- Pass the host's call id as `callId` on the tool use and its result.
- Call `judge(toolUse)` before the call and `afterTool(toolResult)` after it
  (Claude Code: PreToolUse, then PostToolUse or, for a call that failed such
  as a command exiting non-zero, PostToolUseFailure; pi: tool_call and
  tool_result), and show `message` to the agent when it is not null.
- Let the event loop drain after answering, so records are not lost.

## Limits

The check covers watched files only and runs after the command, so a command
can still read or send protected content while it runs. A file larger than the
copy limits, and every file when the snapshot was tampered with, is reported
rather than restored. Restoring from the commit writes the file's bytes and
leaves git's index alone; it does not restore the file's mode. Claude Code
fires no hook when a user interrupts a running call (the interruption reaches
Claude in the tool result instead), so such a call is not checked; its
snapshot expires.
