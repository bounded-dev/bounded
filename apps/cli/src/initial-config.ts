// The configuration `bounded init` writes: live, selecting the core and the
// path gate, with the default rules that keep agents off the project's
// guardrails. The path gate ships no rules of its own (ADR 2026-009), so the
// defaults live here, where the project can see and change them. Content is
// the CLI's: the core's init feature writes whatever text it is given.

export const INITIAL_CONFIG = `// Bounded's configuration for this project, written by \`bounded init\`.
// It selects the core and the path gate. The seven rules below are defaults:
// they keep agents from changing this configuration, Bounded's own state in
// .bounded/, the hooks that run Bounded (Claude Code's settings files, any of
// which could turn hooks off, and pi's loader), Bounded's installed code, and
// git's hooks and config (git runs hooks later, outside Bounded's view).
// Change or remove them as you see fit, and add your own rules; the README's
// "Installing" section shows how. ~/.claude/settings.json, outside the
// project, is not covered. Bounded discourages agents and records what they
// do; it is not a security boundary: pair it with your host's sandbox.
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
      {
        match: ".claude/settings*.json",
        deny: ["create", "modify", "delete"],
        why: "Claude Code's settings hold Bounded's hook",
        redirect: "Ask a person to change Claude Code's settings",
      },
      {
        match: ".pi/extensions/bounded/**",
        deny: ["create", "modify", "delete"],
        why: "pi's loader for Bounded",
        redirect: "Ask a person to change pi's Bounded loader; \`npx bounded update\` writes it",
      },
      {
        match: "node_modules/bounded/**",
        deny: ["create", "modify", "delete"],
        why: "Bounded's own installed code",
        redirect: "Ask a person to install or upgrade Bounded (\`npx bounded update\`)",
      },
      {
        match: ".git/hooks/**",
        deny: ["create", "modify", "delete"],
        why: "git runs these hooks later, outside Bounded's view",
        redirect: "Ask a person to add or change git hooks; describe the check you need",
      },
      {
        match: ".git/config",
        deny: ["create", "modify", "delete"],
        why: "git's config can point core.hooksPath at hooks of its own",
        redirect: "Ask a person to change git's configuration; run git with \`-c name=value\` for a one-off setting",
      },
    ]),
  ],
});
`;
