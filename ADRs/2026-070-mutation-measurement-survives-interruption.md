# 2026-070: The mutation measurement survives interruption, samples enough, and fits its host's time

**Status:** accepted

## Decision

- **A restore journal.** Before each mutant, `mutation-score` writes the
  file's original bytes and a record (file, edit, both hashes, process id,
  host) to `.bounded/mutation-score/`, atomically, outside the source roots.
  It clears them only after the restore is verified
  (`agent/packs/ts/scripts/mutation-journal.ts`).
- **Every ts gate restores leftovers first.** The ts pack wraps every entry
  of its gate registry, the one entry point both hosts call. So does the
  measurement itself, before collecting sites. A leftover is restored only
  when two things hold: the process that wrote it is gone (the same
  pid-and-host test as the orphaned throwaway database), and the file holds
  exactly the recorded mutant. While the owner lives, the gate blocks and
  touches nothing. A file that matches neither hash also blocks and is left
  alone: only a person can merge an edit made over a mutant. A restore also
  drops the killed run's saved progress. Restores and refusals are guard
  events under `mutation-score` (`detail.kind`: `leftover-restored`,
  `leftover-refused`).
- **Signals.** For the length of its loop, the measurement handles SIGINT and
  SIGTERM. It restores the file in flight, verifies it, clears the journal,
  logs `interrupted`, removes its listeners and re-raises the signal. The
  prepared-service listener (`withPreparedServices`) runs in the same emit.
  SIGKILL is the journal's case.
- **A minimum sample of 40, taken systematically.** The sample is at least
  40 mutants, or every site when there are fewer. `--max-mutants` raises it.
  Asking for fewer is misuse (exit 2). Sites are taken at evenly spaced
  indices over the (file, offset) list, so each file gets mutants in
  proportion to its sites. The report and the guard event give the sample
  size and the site count beside the score.
- **A budget per call, from the host.** The core names one host-to-gate
  convention, `BOUNDED_COMMAND_TIMEOUT_MS`
  (`agent/src/host.ts`): how long the host lets this command run. The Claude
  Code hook sets it from the Bash call's own timeout (default 2 minutes, at
  most 10). The measurement's budget is that deadline less the larger of 15%
  and 15 s. A mutant, or the baseline, starts only when its full timeout
  still fits. Otherwise the call stops cleanly and reports PARTIAL with no
  score.
- **Continuation.** Verdicts are saved after every mutant. They are keyed by
  a fingerprint of the sample, the per-mutant timeout, every file under the
  source roots and every test-side file. The next call over an unchanged tree
  continues without re-running the baseline. Any change starts the sample
  over. Without a deadline (pi, a bare shell) the whole sample runs in one
  call.

The measurement stays advisory (TN-26-002).

## Why

A dogfood run hit Claude Code's 10-minute command limit mid-measurement. The
`finally` that restores the file never ran. `!==` stayed in a store, and no
guard event said so; only the next green gate noticed. The same run capped
the sample at 10 of 397 sites. Round-robin selection with a cap below the
file count reaches only the alphabetically first files, so no domain file
was mutated. A sample's precision depends on how many mutants it holds, not
on what share of the sites they are. That makes the minimum a count, and 40,
the old default, keeps recorded scores comparable. A fixed time limit in the
pack would put one host's limit in a pack, and it would still be wrong when
the model passes a shorter timeout. Host facts belong to the host adapter
(ADR 2026-034).

## Consequences

On Claude Code a measurement may take several calls. The architect's brief
says to call again with the same flags until it prints a score. A short Bash
timeout makes the measurement slow, never unsafe. A gate blocked by a
leftover is not a role's defect to fix. The message names the file, the saved
original and the journal to delete once the file is right.
