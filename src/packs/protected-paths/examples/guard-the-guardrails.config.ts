import { contribution, defineConfig } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";

/**
 * Guard the guardrails, and what is generated or already applied
 *
 * Agents may not change this configuration, Bounded's own state, the hooks
 * that run Bounded (Claude Code's settings and pi's loader), Bounded's
 * installed code, or git's hooks and config: every path `bounded init`'s
 * defaults protect. Generated code is changed through its generator, with
 * the generator's own notes left editable, and applied migrations are
 * history: a new migration may be added, an existing one is never changed
 * or deleted. Drift puts back what a shell command changes in the
 * configuration, Claude Code's settings, pi's loader, generated code and
 * migrations; it never watches `.bounded/`, `.git` or `node_modules`.
 */
export default defineConfig({
  packs: [protectedPathsPack],
  contributes: [
    contribution(protectedPathsPack.points.protectedPaths, [
      {
        match: "**/bounded.config.*",
        deny: ["create", "modify", "delete"],
        why: "the project's guardrails are changed by people, not by agents",
        redirect: "Ask a person to change the project's Bounded configuration; describe the change you need",
      },
      {
        match: ".bounded/**",
        deny: ["create", "modify", "delete"],
        why: "Bounded's own state and log",
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
        redirect: "Ask a person to change pi's Bounded loader; `npx bounded update` writes it",
      },
      {
        match: "node_modules/bounded/**",
        deny: ["create", "modify", "delete"],
        why: "Bounded's own installed code",
        redirect: "Ask a person to install or upgrade Bounded (`npx bounded update`)",
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
        redirect: "Ask a person to change git's configuration; describe the setting you need",
      },
      {
        match: "generated/**",
        except: ["generated/README.md"],
        deny: ["create", "modify", "delete"],
        why: "generated/ is written by the generator",
        redirect: "Change the generator's input, then run the generator",
      },
      {
        match: "migrations/**",
        deny: ["modify", "delete"],
        why: "applied migrations are history",
        redirect: "Add a new migration instead",
      },
    ]),
  ],
});
