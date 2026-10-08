// Content search on Claude Code: `grep` through Bash (#35).
//
// This host gives no session a Grep tool it can rely on (listing.ts says
// why), so a role that wants a call site would read whole files. This is the
// minimal read-only grammar instead, mapped onto the call pi's own `grep` tool
// makes — a path plus an optional file glob — and judged by the same decide()
// rules (ADR LEG-2026-057): a file is judged as a read; a directory search needs
// the host's complete, link-free, ASCII listing of the tree, and a blind
// role's needs a file glob that provably keeps it off the other side.
//
//   grep [-rnHhiFEwlcovsx]... [--include='<glob>'] -e '<pattern>' <dir-or-file>
//   grep [-rnHhiFEwlcovsx]... [--include='<glob>'] '<pattern>' <dir-or-file>
//
// One pattern, one path, the path last, options before it — the one order
// GNU grep, BSD grep and the bundled ugrep all read the same way (BSD stops at
// the first operand). Refused, because each widens what a search reads or
// runs, or means different things to different greps:
//
//   · `-R` (follows every link), `-f` (patterns from a file — another file's
//     content), `-z`/`-Z`/`--null*`, context (`-A`/`-B`/`-C`), `-L`, `-P`,
//     `-a`, `-U`, `-d`/`-D`, and every long option but `--include=`;
//   · in particular the bundled grep's own escapes: Claude Code runs `grep`
//     as a shell function over its bundled ugrep, and hands any argument
//     shaped like `--filter`, `--pager`, `--view`, `--format-open`,
//     `--config`, `--save-config`, `---…`, `-@…`, `-z`/`-Z` or `--null` to the
//     system grep instead (ugrep's `--filter` runs commands; `--config` reads
//     a file). None of those can pass this grammar, so an allowed search
//     always runs on the bundled ugrep, as the tests pin;
//   · more than one pattern (`-e` twice), more than one path, `--`;
//   · an include glob with `/`, `,`, whitespace or `{[?!` — the greps disagree
//     on those, and ADR LEG-2026-057 refuses them on every host.
//
// Pure.

export interface SearchCall {
  readonly path: string;
  readonly pattern: string;
  /** The `--include` glob, as pi's grep `glob` field. */
  readonly glob?: string;
}

export type Search = { readonly ok: true; readonly call: SearchCall } | { readonly ok: false; readonly reason: string };

/** The usage line a refusal ends with. */
export const SEARCH_USAGE = "grep -rn [-i] [-F|-E] [--include='<glob>'] -e '<pattern>' <dir-or-file>";

/** Single-letter options every grep reads the same way and that read nothing
 *  beyond the files searched. */
const FLAG_CLUSTER = /^-[rnHhiFEwlcovsx]+$/;
const INCLUDE = "--include=";
/** Include-glob characters the greps (or ADR LEG-2026-057) do not agree on. */
const UNSAFE_GLOB = /[/,\s{}[\]?!\\]/;

const no = (reason: string): Search => ({ ok: false, reason: `${reason} — search here is ${SEARCH_USAGE}` });

/**
 * The bundled grep's escapes: Claude Code's `grep` shell function hands the
 * whole call to the system grep when ANY argument matches one of these shell
 * `case` patterns (as written into its shell snapshot by Claude Code 2.1.286).
 * An argument that matches one is refused, so an allowed search always runs
 * on the bundled ugrep it was judged for.
 */
export const BUNDLED_GREP_ESCAPES: readonly RegExp[] = [
  /^-.*-filter/, /^-.*-pager/, /^-.*-view/, /^-.*-format-open/, /^-.*-config/, /^---/, /^-@/,
  /^-.*-save-config/, /^-[Zz]/, /^-[^-].*[Zz]/, /^--null$/, /^--null-data$/,
];

export function isSearch(argv: readonly string[]): boolean {
  return argv[0] === "grep";
}

/** Read a `grep` argv as one search, or say why it is not one. */
export function searchCall(argv: readonly string[]): Search {
  if (argv[0] !== "grep") return no(`'${argv[0] ?? ""}' is not a search command`);
  let pattern: string | undefined;
  let glob: string | undefined;
  const operands: string[] = [];
  const escape = argv.slice(1).find((arg) => BUNDLED_GREP_ESCAPES.some((pattern) => pattern.test(arg)));
  if (escape !== undefined) return no(`'${escape}' would hand the search to another grep`);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (operands.length > 0 && arg.startsWith("-")) return no(`options go before the pattern and path ('${arg}')`);
    if (arg === "-e") {
      const value = argv[i + 1];
      if (value === undefined || value === "") return no("-e takes the pattern");
      if (pattern !== undefined) return no("one pattern per search");
      pattern = value;
      i++;
      continue;
    }
    if (arg.startsWith(INCLUDE)) {
      if (glob !== undefined) return no("one --include glob per search");
      const value = arg.slice(INCLUDE.length);
      if (value === "" || UNSAFE_GLOB.test(value)) {
        return no(`--include takes one plain file-name glob such as '*.handler.ts' ('${value}' is not one)`);
      }
      glob = value;
      continue;
    }
    if (arg.startsWith("-")) {
      if (FLAG_CLUSTER.test(arg)) continue;
      return no(`grep '${arg}' is not allowed`);
    }
    operands.push(arg);
  }
  if (pattern === undefined) {
    if (operands.length !== 2) return no("one pattern and one path");
    pattern = operands[0]!;
    operands.shift();
  }
  if (operands.length !== 1) return no("one path per search, given last");
  const path = operands[0]!;
  if (path === "" || pattern === "") return no("a search takes a non-empty pattern and path");
  // The bundled grep inspects EVERY argument, the pattern included, when it
  // decides whether to hand the call to the system grep; a pattern that looks
  // like an option is refused, so the search always runs where it was judged.
  if (pattern.startsWith("-")) return no("a pattern may not start with '-' — write it as '[-]…'");
  return { ok: true, call: { path, pattern, ...(glob !== undefined ? { glob } : {}) } };
}

/** The pi `grep` input the gate judges for one search. */
export function searchGateInput(call: SearchCall): Readonly<Record<string, unknown>> {
  return { path: call.path, pattern: call.pattern, ...(call.glob !== undefined ? { glob: call.glob } : {}) };
}
