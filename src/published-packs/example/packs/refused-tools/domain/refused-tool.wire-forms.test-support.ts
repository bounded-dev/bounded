// The wire forms of a refused tool that the pack's own tests expect
// RefusedTool.parse to accept. The package catalogue's schema for the
// refusedTools point must accept each of them
// (src/published-packs/example/test/refused-tools.catalogue.test.ts), as the
// shipped packs' wire forms are checked against bounded's (ADR 2026-029).

/** Every wire form of a refused tool the concept tests accept. */
export const refusedToolWireForms: readonly unknown[] = [
  { tool: "web", redirect: "Read the docs in docs/ instead" },
  { tool: "shell", redirect: "Use the file tools; ask a person to run commands" },
  { tool: "subagent", redirect: "Do the work in this session" },
];
