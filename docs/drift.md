# Drift: undoing what shell commands change

A guard judges a tool call from its effects, but a shell command's effects
cannot be read from its text: `./regenerate.sh` may rewrite files the path
gate protects. So the core checks protected files around every allowed shell
command and undoes any change.

## Watched paths

Packs and projects contribute to the core pack's `watchedPaths` point: files
a shell command must not change, and which changes it must not make to them
(`create`, `modify`, `delete`; every one when `changes` is left out).

```ts
contribution(corePack.points.watchedPaths, [
  { match: "generated/**", except: ["generated/README.md"], why: "generated/ is written by the generator", redirect: "Change the generator's input instead" },
  { match: "migrations/**", changes: ["modify", "delete"], why: "applied migrations are history", redirect: "Add a new migration instead" },
]);
```

The path gate contributes each rule that denies a write, with the writes it
denies. Only those changes are undone: under the `migrations/**` path above a
command may add `migrations/0002_add.sql` (it is left in place, with nothing
reported), but a change to or deletion of an existing migration is put back.

`match` and `except` are project-relative globs; a file is watched by every
rule that matches it and does not except it; when several do, a change any
of them forbids is undone, reported under the first that forbids it. `match` ignores case, as
the path gate's does, so a file cannot be dodged by its case on a
case-insensitive file system; `except` is exact.

**Never watched:** `.bounded/` (bounded's own state, including the decision
log `.bounded/guard-log.jsonl`), and every `node_modules/` and `.git/`
directory at any depth, with everything under them. So a shell command can
edit or delete the guard log, and nothing undoes it: the log's value as
evidence rests on the same limit as the snapshots (anything running as the
same user can change it). Protecting files inside `node_modules` is out of
scope: installs rewrite dependencies all the time, and reading them would make
every command slow.

**Finding the files.** In a git repository the files come from git: tracked
and untracked files (`git ls-files -c -o --exclude-standard`), and ignored
files and ignored directories (`git ls-files -o -i --exclude-standard
--directory`), so a protected file that is ignored, such as `.env`, is still
watched; an ignored directory is walked only where a rule's fixed leading
part may lead. Outside git the project is walked the same way, entering only
the directories a rule's fixed leading part leads to (`generated/**` walks
`generated/`; a `**`-led rule walks the project). Either way a link is never
followed: a linked directory is never entered, and a link a rule matches is
recorded as a link, by where it points. If git cannot list a repository's
files, the command is refused. Files inside a git submodule are not watched:
git lists the submodule as one entry, and its files are never read.

A glob never matches a control character, so a file whose name holds one
(such as a newline, `generated/we\nird.ts`) is watched conservatively, by the
first rule whose fixed leading folder holds it (any rule without one), its
exceptions aside. Messages show such names escaped, as in JSON.

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
   modified or deleted, from its copy or from the commit it matched, with its
   executable bit. A file the command created is never deleted: it is moved
   into a quarantine directory of its own,
   `$XDG_STATE_HOME/bounded/<sha256 of the project root>/quarantine/<time>/<path>`
   (directories 0700, files 0600), and the message and the record say where.
   It checks the files now
   match the snapshot, records a refusal in the guard log (note "changed
   by a shell command; restored") and returns a message for the agent:

   > This command changed protected files, and they were restored:
   > generated/a.ts was modified, generated/new.ts was created — protected
   > because generated/ is written by the generator. Change the generator's
   > input instead. What it created was moved, not deleted, to
   > ~/.local/state/bounded/…/quarantine/….

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
> last commit: generated/a.ts was modified — protected because … Check them
> against version control.

A snapshot that is simply missing (deleted, or expired) is treated the same
way, but says nothing when no watched file differs from the last commit.
Every failure while checking is recorded too.

Detection has a limit: a snapshot forged consistently by the same user (each
copy rewritten together with its hash, and each file kept by the commit
pointing at a commit that holds the forgery) passes every check, and then the
forgery is what is restored. Drift stops agents' shell commands from changing
protected files by accident or in passing, not a determined process running
as the same user.

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
copy limits, a link, and every file when the snapshot was tampered with, is
reported rather than restored. Restoring writes the file's bytes and its
executable bit, and leaves git's index alone. Quarantined files are kept until
someone removes them. Removing a file's entry from a snapshot makes the file
look created, so it is moved aside: reported, never lost. Claude Code
fires no hook when a user interrupts a running call (the interruption reaches
Claude in the tool result instead), so such a call is not checked; its
snapshot expires.
