// File-name listing on Claude Code: `ls` and `find` through Bash (#35).
//
// Why Bash, and not the Glob tool: Claude Code's native builds bundle their
// own search binaries and drop the Glob and Grep tools from the session,
// pointing the model at `find` and `grep` through Bash instead ("Glob is not
// available in this session — find files with `find` via the Bash tool
// instead"). A session gets them back only when it is LAUNCHED naming them
// (`--tools` or `--allowedTools`), which a project cannot arrange, and a
// subagent definition's `tools:` line does not opt in. So a definition that
// lists Glob offers a tool the host does not provide, and the role guesses
// paths. Bash is always there, and it already carries the gates.
//
// The grammar is deliberately small, so that it means the same thing to every
// `find` and `ls` a shell might run (the bundled one, BSD, GNU) and lists names
// only:
//
//   ls [-1aAFp]... [<dir>]
//   find <dir> [-type f|d|l] [-name|-iname|-path|-ipath '<glob>'] [-maxdepth N] [-mindepth N] [-print] ...
//
// Every other flag and primary is refused: `ls -R` and `ls -l` (recursion and
// metadata), `find -exec`/`-delete`/`-fprint` (actions), `-L`/`-H` (following
// links), `-o`/`!`/`(` (logic the gate would have to model). The command has
// already been read the way the shell will read it (bash-policy.ts
// `shellWords`), so a glob reaches here only quoted, as one literal argument.
//
// What comes out is the call pi's own `ls` or `find` tool would make, which
// the path gate then judges with the same decide() (ADR LEG-2026-057: names may be
// listed, contents stay blind). Pure.

/** One listing, as the pi call the gate judges. */
export interface ListingCall {
  readonly tool: "ls" | "find";
  readonly path: string;
  /** The name/path globs a find carries; each is judged as a find pattern. */
  readonly patterns: readonly string[];
}

export type Listing = { readonly ok: true; readonly call: ListingCall } | { readonly ok: false; readonly reason: string };

/** The usage line a refusal ends with. */
export const LISTING_USAGE = "ls [-1aAFp] [<dir>], or find <dir> with only -type, -name, -iname, -path, -ipath, -maxdepth, -mindepth, -print";

const LS_FLAGS = /^-[1aAFp]+$/;
const FIND_TYPES: ReadonlySet<string> = new Set(["f", "d", "l"]);
const FIND_PATTERNS: ReadonlySet<string> = new Set(["-name", "-iname", "-path", "-ipath"]);
const FIND_DEPTHS: ReadonlySet<string> = new Set(["-maxdepth", "-mindepth"]);

const no = (reason: string): Listing => ({ ok: false, reason: `${reason} — listing here is ${LISTING_USAGE}` });

/** Is this argv a listing command at all? */
export function isListing(argv: readonly string[]): boolean {
  return argv[0] === "ls" || argv[0] === "find";
}

/** Read an `ls` or `find` argv as one listing, or say why it is not one. */
export function listingCall(argv: readonly string[]): Listing {
  if (argv[0] === "ls") return lsCall(argv.slice(1));
  if (argv[0] === "find") return findCall(argv.slice(1));
  return no(`'${argv[0] ?? ""}' is not a listing command`);
}

function lsCall(args: readonly string[]): Listing {
  let path: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!LS_FLAGS.test(arg)) return no(`ls '${arg}' is not a names-only flag`);
      continue;
    }
    if (path !== undefined) return no("ls lists one directory per call");
    if (arg === "") return no("ls takes a non-empty path");
    path = arg;
  }
  return { ok: true, call: { tool: "ls", path: path ?? ".", patterns: [] } };
}

function findCall(args: readonly string[]): Listing {
  const path = args[0];
  if (path === undefined || path === "") return no("find takes the directory to search first");
  if (path.startsWith("-") || path === "!" || path === "(") return no(`find '${path}' before the directory is not allowed`);
  const patterns: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const primary = args[i]!;
    const value = args[i + 1];
    if (primary === "-print") continue;
    if (primary === "-type") {
      if (value === undefined || !FIND_TYPES.has(value)) return no("find -type takes f, d or l");
      i++;
      continue;
    }
    if (FIND_DEPTHS.has(primary)) {
      if (value === undefined || !/^\d{1,3}$/.test(value)) return no(`find ${primary} takes a whole number`);
      i++;
      continue;
    }
    if (FIND_PATTERNS.has(primary)) {
      if (value === undefined || value === "") return no(`find ${primary} takes a quoted glob`);
      patterns.push(value);
      i++;
      continue;
    }
    if (!primary.startsWith("-")) return no("find searches one directory per call");
    return no(`find '${primary}' is not a names-only primary`);
  }
  return { ok: true, call: { tool: "find", path, patterns } };
}

/** The pi calls the gate judges for one listing: one per find pattern (a
 *  pattern must stay inside the searched directory), or one bare call. */
export function gateInputs(call: ListingCall): readonly Readonly<Record<string, unknown>>[] {
  if (call.patterns.length === 0) return [{ path: call.path }];
  return call.patterns.map((pattern) => ({ path: call.path, pattern }));
}
