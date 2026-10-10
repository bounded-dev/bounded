# bounded/prereqs: an action needs a prerequisite

A pack shipped in `bounded` 3.2.0 ([ADR 2026-019](../../../docs/adr/2026-019-prereqs-pack.md));
it counts runs at their finish from 3.3.0 ([ADR 2026-025](../../../docs/adr/2026-025-agent-run-finish.md)),
and from 3.3.0 judges shell commands from their reading ([ADR 2026-020](../../../docs/adr/2026-020-shell-command-reading.md)).

## What it is for

Making an agent's work follow the order a project's workflow sets: no
building before the plan is reviewed, no tests before the spec is
reviewed, no `terraform apply` before the infrastructure change is
reviewed. A rule says that before an action, a delegation to an agent must
have succeeded over files that have not changed since. It is not a phase or
a state machine, and there is no "mark done" tool: the agent never claims
anything; the harness observes.

## Rule shape

Projects contribute rules to the pack's one point, `rules`. A rule is
`{ before, require, unchangedSince, redirect }`:

- `before` is one action: `{ delegate: <agent> }` (a delegation to that
  agent in any spelling: ignoring case (lower-cased, upper-cased, then
  lower-cased again, so 'ß', 'ẞ' and 'SS' are one spelling) and
  surrounding spaces, since a host
  may resolve another spelling to the same agent), `{ write: <pattern> }`
  (a file tool's write to a path the pattern matches, or a shell command
  whose reading writes one), or `{ execute: "<program> <words>" }` (a shell
  command that runs the program with those leading arguments; from 3.3.0).
- An execute rule names a program and its subcommand words, separated by
  spaces, as the program receives them: no quoting, shell syntax, path or
  option (`"terraform apply"`, `"git push"`, `"make"`). It is matched
  against the reading the host made of each shell command: a program run
  named so, or whose path ends so, ignoring case (`/usr/local/bin/terraform`),
  whose arguments give the words exactly, after any options
  (`terraform -chdir=infra apply` and `git -C sub push` count; an option
  may take the next word as its value, so `git --no-pager log push` counts
  too). Wrapped and nested runs count (`sudo`, `env`, `timeout`,
  `bash -c '…'`, `find -exec`, `xargs`).
- **Where the pack knows it cannot see what a shell command does, it
  refuses while the rule does not hold**, saying it cannot see and why, and
  how to let it see. What it does not know it cannot see is listed under
  "What it cannot see" below. A command that certainly does what the rule comes before is refused
  for that instead. For example, under the rule
  `{ before: { execute: "terraform apply" }, … }` of
  `review-infra-before-apply.config.ts`:
  - `$TF apply`: "This call would execute `$TF apply`, and bounded cannot
    see whether it runs 'terraform apply': it runs a program whose name
    only the shell can resolve ('$TF')", redirect the rule's, then " (or,
    if this command does not run 'terraform apply', write it so that
    bounded can read it: …)";
  - `terraform $CMD`, `echo apply | xargs terraform`: an argument only the
    shell can resolve stands before 'apply' could be found;
  - `eval …`, `python3 -c …`, `… | sh`, `bash <<EOF`: code bounded cannot
    read (only the rule's redirect);
  - `echo terraform`, `ssh host terraform apply`, `/usr/bin/env terraform
    apply`, `bash deploy.sh`, `/bin/bash -c 'cd infra;terraform apply'`,
    `watch "terraform apply $FLAGS"`: a run passing the program in an
    argument may run it (only the rule's redirect). Every argument is
    looked at, words only the shell can resolve included: its quotes and
    backslashes deleted, split at every character that cannot be part of a
    program's name or path (anything but letters, digits, `.`, `_`, `+`,
    `-` and `/`), each piece compared by its last path segment, ignoring
    case (`terraform-docs` is another program);
  - an unread command: it could not be read (reinstall bounded's
    dependencies, or split or simplify the command).

  Under a write rule: a write only the shell can resolve (`echo x >
  "$OUT"`), a write outside the project (`/tmp/x`, `~/x`, `../x`,
  `src/../../x`; never
  `/dev/null`, `/dev/stdout`, `/dev/stderr` or `/dev/fd/<n>`), unresolved
  code, or a run whose program's name only the shell can resolve
  (`$TOOL x`). Once the requirement holds, every such command is allowed.
- `require` is a delegation to an agent that succeeded, matched exactly
  against the agent the host says it ran, as it resolved the requested name.
  A request spelled "Plan-Reviewer" that Claude Code ran as plan-reviewer
  meets `require: { delegate: "plan-reviewer" }`; a run the host resolved to
  another name, even in case only ("Mixed-Case" is not "mixed-case"), does
  not; and a run whose host does not say which agent ran does not count. A
  rule cannot require the action it comes before, in any spelling.
- `unchangedSince` names the files the run must have seen as they are now.
  Patterns are checked as the protected-paths pack's, and matched as its `match`:
  ignoring case, seeing dotfiles; a pattern without a glob covers everything
  under it. Gitignored files count, but `.bounded`, `node_modules` and
  `.git` are never fingerprinted, so a pattern leading into any of them is
  refused.
- A `before.write` pattern matches a write exactly as the protected-paths pack's
  `match` does, with nothing excluded: a rule over `node_modules/**` or
  `.git/**` comes before writes there. One inside `.bounded` is refused.
- `redirect` is what the agent is told to do instead.

Rules with the same requirement (agent and patterns) share records: in
`review-plan-before-building.config.ts`, one review of the plan meets both
plan-reviewer rules.

## Workflows it fits

- **Plan, review, build:** a reviewer approves the current plan before the
  builder agent runs or `src/` is edited, and an edit to the plan makes the
  approval stale.
- **Spec first:** a reviewer approves the spec and the contracts before a
  test-writer agent writes tests against them.
- **Reviewed infrastructure:** a reviewer approves the current `infra/`
  files before a command runs `terraform apply`, or any other program and
  subcommand a project names.

Each needs the required agent to be a delegation the host reports the
finish of: Claude Code's subagents do; on pi, a requirement cannot be met
yet (see "What it observes").

## What it observes

- **Before a call:** an action a rule comes before is refused unless a
  record of its requirement has the fingerprint its files have now. Refusals
  begin `bounded/prereqs.rules:`, name the contributing pack and the rule,
  and carry its redirect. The first rule that does not hold, in contribution
  order, refuses.
- **A delegation that may run a required agent** (its requested name is
  the required agent's, ignoring case (lower-cased, upper-cased, then
  lower-cased again) and surrounding spaces) has its files
  fingerprinted as it starts. It is refused when it runs isolated (on a
  separate copy of the files, such as a worktree), when the host will not
  report its finish (a Claude Code teammate, any pi run that does not say
  `async: false`), or when it has no call id.
- **A run the host says finished, on its result** (a foreground run): it is
  recorded when it succeeded, the host says it ran the required agent
  exactly, and the files' fingerprint is the one taken at the start.
  Otherwise nothing is recorded, and the agent is told why.
- **A run whose finish the host reports later** (a background run: Claude
  Code's launch result, then its SubagentStop): its start is kept for the
  run, and it is recorded at its finish under the same conditions. Nothing
  is said at launch. Meanwhile an action its rule comes before is refused
  as **pending**: "<agent>'s run started at <T> has not finished yet: wait
  for its finish", with a redirect to wait or, if the run stopped without
  finishing, to do what the rule says. Pending never allows, and a run over
  files changed since its launch is not waited on. No agent is told about a
  finish, so why a background run did not count is in the Bounded log.
- **Whether a run ran to its end:** a finish that says it did not never
  counts; one that says it did, or does not say, counts. Claude Code never
  says.

A run that never finishes never counts: Claude Code (2.1.294, captured)
sends no SubagentStop for a run stopped at its turn limit, foreground or
background, nor for a background run stopped with TaskStop. Such a run shows
as pending for up to seven days; run the agent again, to its end. Not
captured, so unknown: whether a run interrupted by the user (Esc) or ended by
an API error fires SubagentStop. If it does, Claude Code does not say how the
run ended, and the run counts.

**On pi, a requirement cannot be met yet.** pi-subagents 0.52.1 runs a
`subagent` call in the background unless it says `async: false`
(`asyncByDefault` defaults to true, `src/extension/config.ts:150-151`), and
even then its `forceTopLevelAsync` setting can run it in the background
(`src/runs/background/top-level-async.ts:7-14`), and a timed-out child may
leave `isError` unset (`src/runs/foreground/subagent-executor.ts:3544`). So
a delegation without `async: false` is refused, and no pi result is counted
as finished: the agent is told that the host does not report when the agent
finishes, so it cannot meet the requirement yet. This holds until the pack observes pi-subagents' completion (ADR 2026-019,
"Future work").

## What it cannot see

- **A reviewer's verdict.** "Succeeded" is the tool result's `ok`, not what
  the reviewer concluded.
- **Cycles across rules**, which make an action unreachable.
- **A glob or brace a program the reader does not interpret expands
  itself.** A literal argument holding no `$`, backquote, `;`, `&&`, `||`,
  `|` or newline is read as text, so the rule's program is found there
  only where its name is written out: `ssh host '/*/bin/terrafor? apply'`, `ssh host '/usr/bin/terra{form,} apply'` are allowed while the requirement is unmet (so that
  `prettier --write 'src/**'` is not refused). One holding those is code,
  and refused (below, "Over-refusal"). A `<` from a file into such a
  program is a read (`ssh host < cmds.txt` is allowed).
- **What a prefix does not match.** It matches a run's first positional
  words, in order, past options only: under `"make deploy"`,
  `make clean deploy` (which builds the deploy target too) does not count.
  A git alias defined on the command line (`git -c alias.x=push x`) evades
  a `"git push"` rule, as does any alias the program itself expands.
- **What a shell command's reading does not show.** What programs and
  scripts run from elsewhere (an execute rule catches what a listed run is
  given only where the rule's program's name stands in one of its
  arguments); aliases and functions from the host's
  shell (`tf apply`); git's `!` aliases; a program named `terraform.exe`; a
  script run through a shell, never seen to run (refused as cannot see
  only when its name is the rule's program, written out as an argument:
  `bash deploy.sh`; a sourced script, `. deploy.sh`, is code bounded cannot
  read, refused under any rule; a script the shell names where the shell's
  options are, `bash "$S"`, is refused as code bounded cannot read, since
  `"$S"` may hold `-s`; one named after the options, `bash -- "$S"`, or
  substituted, `bash <(curl -s https://example.com/deploy)`, is allowed);
  PowerShell, read as bash.
  Write rules miss in-place edits (`sed -i`) and what ADR 2026-020 names
  as not read (other runners and git subcommands, aliases defined
  elsewhere). Package runners (`npx`, `pnpm exec`, `uvx` …), a program
  named by its path (`/bin/rm`, `/usr/bin/env rm`), `time`, `coproc`,
  `trap`, `alias`, `-execdir` and git's writing subcommands (`git checkout`,
  `git restore`, `git clone` …) are read (ADR 2026-020, amended by
  `shell-reader-coverage`). A delegation run from the shell
  (`claude -p --agent …`) is not seen as one.
- **Over-refusal, by decision:** while a requirement is missing, commands
  bounded cannot read through are refused under any execute or write rule,
  and under an execute rule so is any run naming its program as an
  argument (`echo terraform`, `which terraform`, a commit message naming
  it). Since bounded reads every plausible reading of a word only the
  shell can resolve (ADR 2026-020, amended by `shell-every-reading`), these
  are refused too: `exec "$@"`, `sudo "$@"` and `"$CMD" --version` (a
  program only the shell can name, which may also be a shell reading
  standard input), `bash "$SCRIPT"` and `bash "$X" deploy.sh` (standard
  input), `bash "$S" "$1"` (`"$1"` may be code), `"$W" cd sub && rm x`
  (where `"$W"` may be `builtin`, a `cd` bounded cannot place), and a write
  only the shell can name (`cp "$X" src/`, `mv "$F" notes.txt`,
  `ls | xargs cp -t src`). And, since `shell-reader-coverage`: git
  commands that write `(the working tree)` (`git checkout main`,
  `git stash pop`, `git reset --hard`, `git apply p.patch`,
  `git checkout -- .`, `git checkout -f main`) under any write rule;
  `sudo -s`, `sudo -i`, `doas -s`; a sourced file (`. ./env.sh`);
  `alias c='…'`; a recursive runner (`pnpm -r exec …`); a `{ … }` coproc;
  `time cd …`; and a program bounded's reader does not know given a word
  only the shell can resolve, a here-string or piped input (`mytool "$X"`,
  `cat a | mytool`, `ssh host "terra$()form apply"`, `su -c "$CMD"`,
  `/bin/sh <<< 'terraform apply'`, `cat commands.txt | xargs /usr/bin/env`),
  or a literal argument holding shell syntax (`$`, `$(`, a backquote, `;`,
  `&&`, `||`, `|`, a newline), which ssh, watch and their kind run as shell
  code: `` ssh host 'terra``form apply' ``, `watch 'terra${x}form apply'`,
  and `mytool '$HOME'`; standard input given to a group or loop, or a `<`
  from a process substitution (`while read l; do ssh host; done <<< …`,
  `ssh host < <(echo …)`); and piped input into `sed` (`| sed …`), which
  bounded's reader does not interpret. `grep '$x' f` and `echo '$HOME'`
  stay allowed.
  The common text programs (`cat`, `grep`, `head`, `sort`, `jq` …) are not
  refused for this: `cat a | grep x`, `jq . f.json`, `git log | head` and
  `cat "$F"` are allowed.
- **Patterns that match no file:** such a requirement can never be met, and
  says so.
- **Symbolic links:** a link is never followed. A link to a directory the
  patterns could reach into (a link `stat` cannot examine, other than a
  missing target, counts as one: a loop, or one behind a directory bounded
  may not read), or a link whose own path the patterns match (to a file, or
  dangling), makes the rule refuse, naming the link; replace it
  with the files, or leave it out of the patterns. Any other link is
  ignored.
- **Special files:** a FIFO, socket or device the patterns match makes the
  rule refuse, naming it (failing closed); one they do not match is
  ignored.
- **ABA:** files edited and put back between the delegation and its result
  compare equal, so the run counts.

Keep review logs and other files a run writes out of the patterns it is
fingerprinted over, or every run changes its own files and never counts.

## Records

Records are in the project, in `.bounded/prereqs/records.jsonl` (one line
per recorded run, never compacted), and per project root: a second checkout
starts with none. The starts of delegations awaiting their result are in
`.bounded/prereqs/started/calls/`, kept for a day; the starts of runs
awaiting their finish are in `.bounded/prereqs/started/runs/`, kept seven
days. The Bounded log keeps an audit record of each recorded run.

## The protection it relies on

The guarantee rests on the protected-paths pack keeping agents off:

- `.bounded/**`, where the records are (in `bounded init`'s default rules);
- the project's agent definitions, which say who an agent is:
  `.claude/agents/**` for Claude Code, and pi-subagents' project agent
  directory for pi.

Agent definitions outside the project (`~/.claude/agents/`, pi's user-level
agents) cannot be protected. The pack does not check any of this when it
composes.

## Ports

A host provides both, through `openProject(root, { ports:
[...protectedPathsPortProvisions(), ...prereqsPortProvisions()] })`; the hooks for
Claude Code and pi that `bounded` carries do.

- `fileSetFingerprints` (`FileSetFingerprints`): the fingerprint of the
  files a list of patterns names.
- `prerequisiteRecords` (`PrerequisiteRecords`): the records, the starts
  kept by call id, and the starts kept by run id until the run's finish.

## Examples

Each is a complete `bounded.config.ts`, in `examples/`, opened as a
project's configuration by the package's tests. Each also selects
`bounded/protected-paths` and keeps agents off `.bounded/**` and
`.claude/agents/**` (see "The protection it relies on").

- `review-plan-before-building.config.ts`: before a delegation to
  builder, and before a write under `src/`, plan-reviewer must have
  succeeded over the current plan; one review meets both rules.
- `review-spec-before-tests.config.ts`: before a delegation to
  test-writer, spec-reviewer must have succeeded over the current spec and
  contracts.
- `review-infra-before-apply.config.ts`: before a shell command runs
  `terraform apply`, infra-reviewer must have succeeded over the current
  `infra/` files.
