// The configuration `bounded init` writes: live, selecting the core and the
// path gate, with the two default rules that keep agents off the project's
// guardrails. The path gate ships no rules of its own (ADR 2026-009), so the
// defaults live here, where the project can see and change them. Content is
// the CLI's: the core's init feature writes whatever text it is given.

export const INITIAL_CONFIG = `// Bounded's configuration for this project, written by \`bounded init\`.
// It selects the core and the path gate. The two rules below are defaults:
// they keep agents from changing this configuration and Bounded's own state
// in .bounded/. Change or remove them as you see fit, and add your own rules;
// the README's "Installing" section shows how.
import { contribution, corePack, defineConfig } from "bounded/domain";
import { pathGate } from "bounded/path-gate";

export default defineConfig({
  packs: [corePack, pathGate],
  contributes: [
    contribution(pathGate.points.protectedPaths, [
      {
        match: "**/bounded.config.*",
        deny: ["create", "modify", "delete"],
        why: "the project's guardrails are changed by people, not by agents",
        redirect: "Ask a person to change the project's Bounded configuration; describe the change you need",
      },
      {
        match: ".bounded/**",
        deny: ["create", "modify", "delete"],
        why: "Bounded's own state and guard log",
        redirect: "Leave .bounded/ to Bounded; ask a person if its state looks wrong",
      },
    ]),
  ],
});
`;
