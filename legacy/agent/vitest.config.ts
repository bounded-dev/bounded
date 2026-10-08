import { configDefaults, defineConfig } from "vitest/config";

// The gate-CLI test files build fixture repos and spawn real subprocesses
// (node running a gate script, npx tsc, vitest-in-vitest). Under full-suite
// parallelism those spawns queue behind each other, and vitest's default 5s
// per-test budget starts timing out tests that pass in isolation every time —
// the suite grew past the machine's threshold when TN-26-006 A1 added ~90
// more subprocess tests. A timeout is a ceiling for hangs, not a performance
// assertion: 30s changes nothing for the thousand fast tests and stops load
// from forging failures in the slow ones.
export default defineConfig({
  test: {
    // packs/ts/reference is a target-project fixture (TN-26-008): its own test
    // files are a worked example, driven through the gates by
    // reference-component.test.ts against a throwaway copy — never collected
    // and run as part of the harness's own suite (they use NodeNext `.js`
    // specifiers and belong to a different tsconfig). Every pack's reference/
    // is such a fixture: ts-hexagonal's runs under `bun test` in a temporary
    // project (packs/ts-hexagonal/reference.test.ts), never under vitest.
    exclude: [...configDefaults.exclude, "packs/*/reference/**", "dist/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The same fixtures fan out further: each worker spawns node/tsc/vitest
    // subprocesses of its own, so unbounded file parallelism multiplies into
    // a process storm the machine cannot schedule on battery power (measured
    // 2026-09-16: single file 83ms, full suite imports 20x slower and three
    // different tests timing out per run). Four workers keeps the storm
    // bounded; on mains it costs seconds, on battery it restores honesty.
    maxWorkers: 4,
    minWorkers: 1,
  },
});
