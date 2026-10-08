// Preloaded into every `bun test` run_tests starts (ADR 2026-062).
//
// bun prints its console report (the failure markers and error text the
// sanitizer reads) on the same stream a test's own console output goes to.
// A test that prints `(fail) <other test> [1ms]` or a caret line could
// otherwise move another test's failure text, or its own fixture data, into
// the builder's view. The builder never sees console output anyway, so this
// silences it at the source: every console method, and JavaScript writes to
// the process's stdout and stderr. bun's own reporter writes natively and is
// unaffected.
//
// A test that writes to file descriptor 2 by some other route (a child
// process, a native call) is not stopped here; the sanitizer's JUnit-backed
// marker check and forbidden-line filter still apply (ADR 2026-062, known
// limits).
const silent = (): void => {};
for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir", "dirxml", "table", "group", "groupCollapsed", "time", "timeEnd", "timeLog", "count", "assert"] as const) {
  (console as unknown as Record<string, unknown>)[method] = silent;
}
const swallow = ((..._args: unknown[]): boolean => true) as typeof process.stderr.write;
process.stderr.write = swallow;
process.stdout.write = swallow;
