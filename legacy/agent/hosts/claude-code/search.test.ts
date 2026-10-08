import { describe, expect, test } from "vitest";
import { shellWords } from "./bash-policy.ts";
import { BUNDLED_GREP_ESCAPES, SEARCH_USAGE, searchCall, searchGateInput } from "./search.ts";

// #35: a read-only content search on Claude Code. The grammar is pinned here;
// the blindness it is judged with is pinned in bash-policy.test.ts.

const argv = (command: string): readonly string[] => {
  const words = shellWords(command);
  if (!words.ok) throw new Error(words.reason);
  return words.argv;
};
const parse = (command: string) => searchCall(argv(command));

describe("searchCall — the grammar", () => {
  test.each([
    ["grep -rn -e 'call(' src", { path: "src", pattern: "call(" }],
    ["grep -rn 'needle' src/a.ts", { path: "src/a.ts", pattern: "needle" }],
    ["grep -rniF --include='*.handler.ts' -e 'x.y' contexts/m/src", { path: "contexts/m/src", pattern: "x.y", glob: "*.handler.ts" }],
    ["grep -r -n -E -e '^export' src", { path: "src", pattern: "^export" }],
    ["grep -rl -e '[-]flag-like' src", { path: "src", pattern: "[-]flag-like" }],
    ["grep -c needle src/a.ts", { path: "src/a.ts", pattern: "needle" }],
  ])("%s", (command, call) => {
    expect(parse(command)).toEqual({ ok: true, call });
  });

  test.each([
    "grep -R needle src", // follows every link
    "grep -rn -f patterns.txt src", // patterns from another file
    "grep -rz needle src",
    "grep -rZ needle src",
    "grep -rn --null needle src",
    "grep -rn -A 3 needle src",
    "grep -rn -C3 needle src",
    "grep -rL needle src",
    "grep -rP needle src",
    "grep -ra needle src",
    "grep -rn -e a -e b src", // two patterns
    "grep -rn needle src lib", // two paths
    "grep -rn needle", // no path
    "grep -rn -e needle", // no path
    "grep -rn -- needle src",
    "grep needle src -r", // option after the operands
    "grep -rn --include='*.ts' --include='*.tsx' needle src",
    "grep -rn --include '*.ts' needle src", // the separate-value form
    "grep -rn --include='src/*.ts' needle .",
    "grep -rn --include='*.handler.ts,*.test.ts' needle src",
    "grep -rn '--include=*.{ts,tsx}' needle src",
    "grep -rn --include='*.[tj]s' needle src",
    "grep -rn --include='!*.test.ts' needle src",
    "grep -rn --exclude='*.test.ts' needle src",
    "grep -rn --exclude-from=x needle src",
    "grep -rn --exclude-dir=x needle src",
    "grep -rn --ignore-files needle src",
    "grep -rn --color=always needle src",
    "grep -rn --binary-files=text needle src",
    "grep -e '' src",
    "grep -rn -e '-zfoo' src", // a pattern the bundled grep would read as an option
    "grep -rn -e '--config' src",
  ])("refused: %s", (command) => {
    const r = parse(command);
    expect(r.ok, command).toBe(false);
    if (!r.ok) expect(r.reason).toContain(SEARCH_USAGE);
  });

  test("maps onto pi's grep input: path, pattern, and the include as its glob", () => {
    const r = parse("grep -rn --include='*.handler.ts' -e 'x' contexts/m/src");
    if (!r.ok) throw new Error(r.reason);
    expect(searchGateInput(r.call)).toEqual({ path: "contexts/m/src", pattern: "x", glob: "*.handler.ts" });
  });
});

// Claude Code runs `grep` as a shell function over its bundled ugrep, and hands
// the call to the SYSTEM grep when any argument matches one of these shell
// `case` patterns (copied from the function Claude Code 2.1.286 writes into its
// shell snapshot). ugrep's --filter runs commands and --config reads a file, so
// these are exactly the options a search must never carry. Pinned both ways: no
// such option passes the grammar, and no argument an allowed search carries
// matches a pattern — so an allowed search always runs on the bundled ugrep.
describe("the bundled grep's escapes to the system grep", () => {
  test.each([
    "--filter=sh", "--filter-magic-label=x", "--pager", "--view=vi", "--format-open=%f", "--config", "--config=f",
    "---x", "-@", "--save-config", "-Z", "-z", "-rZ", "-nz", "--null", "--null-data",
    "--include=*-config.ts",
  ])("refused: %s", (flag) => {
    expect(searchCall(["grep", flag, "needle", "src"]).ok).toBe(false);
  });

  test("no argument of an allowed search matches an escape pattern", () => {
    for (const command of [
      "grep -rnHhiFEwlcovsx -e 'needle' src",
      "grep -rn --include='*.handler.ts' -e 'zz' src",
      "grep -rn 'needle' src/a.ts",
    ]) {
      const words = argv(command);
      expect(parse(command).ok, command).toBe(true);
      for (const option of words.slice(1)) {
        for (const escape of BUNDLED_GREP_ESCAPES) expect(escape.test(option), `${option} ~ ${escape}`).toBe(false);
      }
    }
  });
});
