// The architect uses Git to inspect project history. Mutating Git commands
// bypass file-tool path gates: checkout-index can rewrite a protected file even
// after Edit and rm were refused. Keep this tool read-only on every host.
//
// The rule is an allowlist that fails closed at every level: a global option,
// a subcommand, a sub-subcommand (verb), an option and a positional word are
// each accepted only when this table names them. Positional words matter as
// much as options: `git branch foo` creates a branch and `git reflog expire`
// rewrites history, so each subcommand declares which positional shapes it
// takes. Options that write files (`--output`), run programs (`--ext-diff`,
// `--textconv`, `-O`, `-c`, `--exec-path`) or redirect Git (`-C`, `--git-dir`)
// are simply absent from the table.

type Positionals = "any" | "none" | "withList";

interface Rule {
  /** Options that take no value. */
  readonly flags: ReadonlySet<string>;
  /** Options that require a value, as `--opt=v`, `--opt v`, `-ov` or `-o v`. */
  readonly valued?: ReadonlySet<string>;
  /**
   * Options whose value is optional, so Git only reads it stuck on (`--opt=v`,
   * `-ov`). Never consuming the next word keeps our reading of positionals
   * identical to Git's.
   */
  readonly stuck?: ReadonlySet<string>;
  /** Which positional words are read-only: any revision/path, none, or only in `--list` mode. */
  readonly positionals: Positionals;
  /** Accept `-<n>` as a count (log family). */
  readonly count?: boolean;
}

interface Command {
  /** Rule when no verb follows the subcommand; absent means a verb is required. */
  readonly bare?: Rule;
  /** Read-only verbs (`git stash list`); any other word in verb position is refused. */
  readonly verbs?: Readonly<Record<string, Rule>>;
}

const set = (...items: string[]): ReadonlySet<string> => new Set(items);

const DIFF_FLAGS = [
  "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--check", "--summary",
  "-p", "--patch", "--no-patch", "-s", "-w", "--ignore-all-space", "--word-diff", "--no-color",
  "--no-ext-diff", "--no-textconv", "--no-renames", "-M", "--find-renames", "--full-index", "--raw",
];
const DIFF_VALUED = ["--diff-filter", "--stat-width"];
const DIFF_STUCK = ["--unified", "-U", "--color", "--word-diff", "--relative", "--stat"];
const LOG_FLAGS = [
  ...DIFF_FLAGS, "--oneline", "--all", "--decorate", "--no-decorate", "--graph", "--reverse",
  "--first-parent", "--no-merges", "--merges", "--follow", "--abbrev-commit", "-g", "--walk-reflogs",
];
const LOG_VALUED = [
  ...DIFF_VALUED, "-n", "--max-count", "--skip", "--since", "--until", "--after", "--before",
  "--author", "--committer", "--grep", "-S", "-G", "--date", "-L",
];
// The log family reads `--format` and `--pretty` only as `--format=<f>`: a
// separate next word is Git's own option (`--format --output=/x` truncates
// /x), so both are stuck-only here. branch and tag do take the next word.
const LOG_STUCK = [...DIFF_STUCK, "--format", "--pretty", "--decorate", "--abbrev-commit"];

const LOG: Rule = { flags: set(...LOG_FLAGS), valued: set(...LOG_VALUED), stuck: set(...LOG_STUCK), positionals: "any", count: true };
const SHOW: Rule = { ...LOG, count: false };
const DIFF: Rule = { flags: set(...DIFF_FLAGS), valued: set(...DIFF_VALUED), stuck: set(...DIFF_STUCK), positionals: "any" };

const COMMANDS: ReadonlyMap<string, Command> = new Map<string, Command>([
  ["status", { bare: {
    flags: set("--short", "-s", "--branch", "-b", "--porcelain", "--long", "-z", "--ignored", "--no-renames"),
    stuck: set("--porcelain", "--untracked-files", "-u"),
    positionals: "any",
  } }],
  ["diff", { bare: { ...DIFF, flags: set(...DIFF_FLAGS, "--cached", "--staged", "--merge-base") } }],
  ["log", { bare: LOG }],
  ["show", { bare: SHOW }],
  ["grep", { bare: {
    flags: set("-n", "--line-number", "-i", "--ignore-case", "-F", "--fixed-strings", "-E", "--extended-regexp",
      "-w", "--word-regexp", "-l", "--files-with-matches", "-c", "--count", "-v", "--invert-match",
      "--cached", "--untracked", "-h", "-H", "--heading", "--break"),
    valued: set("-e", "-A", "-B", "-C", "--context", "--after-context", "--before-context", "--max-depth"),
    positionals: "any",
  } }],
  ["ls-files", { bare: {
    flags: set("-s", "--stage", "--cached", "-c", "--others", "-o", "--exclude-standard", "--modified", "-m",
      "--deleted", "-d", "-z", "--error-unmatch", "--full-name"),
    positionals: "any",
  } }],
  ["ls-tree", { bare: { flags: set("-r", "-t", "-d", "-l", "--long", "--name-only", "--full-tree", "-z"), positionals: "any" } }],
  ["rev-parse", { bare: {
    flags: set("--show-toplevel", "--show-prefix", "--show-cdup", "--abbrev-ref", "--verify", "--quiet", "-q",
      "--is-inside-work-tree", "--git-dir", "--absolute-git-dir", "--symbolic-full-name", "--short"),
    positionals: "any",
  } }],
  ["blame", { bare: { flags: set("-w", "-s", "-e", "-l", "--porcelain", "--line-porcelain", "--show-email"), valued: set("-L"), positionals: "any" } }],
  // Positional words create a branch or tag unless explicitly in list mode.
  ["branch", { bare: {
    flags: set("--show-current", "--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose",
      "--merged", "--no-merged", "--no-color"),
    valued: set("--points-at", "--format", "--sort"),
    stuck: set("--contains", "--no-contains", "--merged", "--no-merged"),
    positionals: "withList",
  } }],
  ["tag", { bare: {
    flags: set("--list", "-l", "-n"),
    valued: set("--points-at", "--format", "--sort"),
    stuck: set("-n", "--contains", "--no-contains", "--merged", "--no-merged"),
    positionals: "withList",
  } }],
  // `git reflog <ref>` is show, but refs are only accepted after an explicit
  // `show` so a verb (expire, delete, drop) can never slip through as a ref.
  ["reflog", {
    bare: { ...SHOW, positionals: "none" },
    verbs: { show: SHOW, exists: { flags: set(), positionals: "any" } },
  }],
  // `remote show <name>` contacts the remote (running ssh) unless `-n`.
  ["remote", {
    bare: { flags: set("-v", "--verbose"), positionals: "none" },
    verbs: {
      "get-url": { flags: set("--push", "--all"), positionals: "any" },
      show: { flags: set("-n"), positionals: "withList" },
    },
  }],
  // A bare `git stash` is `git stash push`.
  ["stash", { verbs: { list: { ...SHOW, positionals: "none" }, show: DIFF } }],
  ["worktree", { verbs: { list: { flags: set("--porcelain", "-v", "--verbose", "-z"), positionals: "none" } } }],
]);

/** Options that switch a `withList` rule into list mode, where positionals are patterns or names. */
const LIST_FOR = (sub: string, verb: string | undefined): ReadonlySet<string> =>
  sub === "remote" && verb === "show" ? set("-n") : sub === "tag" ? set("--list", "-l") : set("--list");

const GLOBALS = set("--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs");

/** Undefined accepts a read-only Git invocation; a sentence refuses it. */
export function gitPolicy(args: readonly string[]): string | undefined {
  // Belt over the table: no word of a read-only call may name Git's file
  // output, even where the table would read it as another option's value.
  const output = args.find((arg) => arg.startsWith("--output"));
  if (output !== undefined) return `git argument '${output}' writes a file and is never read-only`;
  let i = 0;
  while (i < args.length && GLOBALS.has(args[i]!)) i++;
  const sub = args[i];
  const command = sub === undefined ? undefined : COMMANDS.get(sub);
  if (sub === undefined || command === undefined) {
    return `git '${sub ?? ""}' is not a read-only architect command`;
  }
  i++;
  let verb: string | undefined;
  let rule = command.bare;
  const next = args[i];
  if (next !== undefined && !next.startsWith("-")) {
    const verbs = command.verbs ?? {};
    if (!Object.hasOwn(verbs, next)) {
      return command.verbs === undefined
        ? checkArgs(sub, undefined, command.bare!, args.slice(i))
        : `git ${sub} '${next}' is not a read-only form (allowed: ${Object.keys(verbs).join(", ")})`;
    }
    verb = next;
    rule = verbs[next];
    i++;
  }
  if (rule === undefined) {
    return `git ${sub} needs a read-only verb (${Object.keys(command.verbs ?? {}).join(", ")})`;
  }
  return checkArgs(sub, verb, rule, args.slice(i));
}

function checkArgs(sub: string, verb: string | undefined, rule: Rule, rest: readonly string[]): string | undefined {
  const name = verb === undefined ? sub : `${sub} ${verb}`;
  const seen = new Set<string>();
  const positionals: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const arg = rest[k]!;
    if (arg === "--") { positionals.push(...rest.slice(k + 1)); break; }
    if (!arg.startsWith("-") || arg === "-") { positionals.push(arg); continue; }
    if (rule.flags.has(arg) || (rule.count === true && /^-\d+$/.test(arg))) { seen.add(arg); continue; }
    const valued = valuedMatch(rule, arg);
    if (valued === "separate") {
      if (k + 1 >= rest.length) return `git ${name} option '${arg}' needs a value`;
      k++;
      seen.add(arg);
      continue;
    }
    if (valued === "stuck") continue;
    return `git ${name} option '${arg}' is not in its read-only allowlist`;
  }
  if (positionals.length === 0 || rule.positionals === "any") return undefined;
  const listMode = rule.positionals === "withList" && [...LIST_FOR(sub, verb)].some((f) => seen.has(f));
  if (listMode) return undefined;
  return `git ${name} '${positionals[0]}' is not a read-only form` +
    (rule.positionals === "withList" ? ` (positional words are only read in ${[...LIST_FOR(sub, verb)].join("/")} mode)` : "");
}

function valuedMatch(rule: Rule, arg: string): "separate" | "stuck" | undefined {
  const takes = (name: string): boolean => rule.valued?.has(name) === true || rule.stuck?.has(name) === true;
  if (rule.valued?.has(arg) === true) return "separate";
  const eq = arg.indexOf("=");
  if (arg.startsWith("--") && eq > 0 && takes(arg.slice(0, eq))) return "stuck";
  if (!arg.startsWith("--") && arg.length > 2 && takes(arg.slice(0, 2))) return "stuck";
  return undefined;
}
