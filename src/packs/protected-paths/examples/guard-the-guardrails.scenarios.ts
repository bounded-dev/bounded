import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [
    {
      title: "Every path bounded init's defaults protect, generated code and applied migrations are refused writes; their carve-outs are not",
      projectFiles: {
        "generated/api.ts": "export const api = 1;\n",
        "generated/README.md": "Written by the generator.\n",
        "migrations/001.sql": "create table a (id int);\n",
      },
      steps: [
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: "bounded.config.ts", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (modify) bounded.config.ts: the rule '**/bounded.config.*' from bounded/project denies modify of 'bounded.config.ts' (the project's guardrails are changed by people, not by agents)",
            redirect: "Ask a person to change the project's Bounded configuration; describe the change you need",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: "packages/app/bounded.config.mjs", change: "create" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (create) packages/app/bounded.config.mjs: the rule '**/bounded.config.*' from bounded/project denies create of 'packages/app/bounded.config.mjs' (the project's guardrails are changed by people, not by agents)",
            redirect: "Ask a person to change the project's Bounded configuration; describe the change you need",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".bounded/log.jsonl", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (modify) .bounded/log.jsonl: the rule '.bounded/**' from bounded/project denies modify of '.bounded/log.jsonl' (Bounded's own state and log)",
            redirect: "Leave .bounded/ to Bounded; ask a person if its state looks wrong",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".claude/settings.json", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (modify) .claude/settings.json: the rule '.claude/settings*.json' from bounded/project denies modify of '.claude/settings.json' (Claude Code's settings hold Bounded's hook)",
            redirect: "Ask a person to change Claude Code's settings",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".claude/settings.local.json", change: "create" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (create) .claude/settings.local.json: the rule '.claude/settings*.json' from bounded/project denies create of '.claude/settings.local.json' (Claude Code's settings hold Bounded's hook)",
            redirect: "Ask a person to change Claude Code's settings",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".pi/extensions/bounded/index.ts", change: "create" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (create) .pi/extensions/bounded/index.ts: the rule '.pi/extensions/bounded/**' from bounded/project denies create of '.pi/extensions/bounded/index.ts' (pi's loader for Bounded)",
            redirect: "Ask a person to change pi's Bounded loader; `npx bounded update` writes it",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: "node_modules/bounded/package.json", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (modify) node_modules/bounded/package.json: the rule 'node_modules/bounded/**' from bounded/project denies modify of 'node_modules/bounded/package.json' (Bounded's own installed code)",
            redirect: "Ask a person to install or upgrade Bounded (`npx bounded update`)",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".git/hooks/pre-commit", change: "create" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (create) .git/hooks/pre-commit: the rule '.git/hooks/**' from bounded/project denies create of '.git/hooks/pre-commit' (git runs these hooks later, outside Bounded's view)",
            redirect: "Ask a person to add or change git hooks; describe the check you need",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".git/config", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (modify) .git/config: the rule '.git/config' from bounded/project denies modify of '.git/config' (git's config can point core.hooksPath at hooks of its own)",
            redirect: "Ask a person to change git's configuration; describe the setting you need",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: "generated/api.ts", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (modify) generated/api.ts: the rule 'generated/**' from bounded/project denies modify of 'generated/api.ts' (generated/ is written by the generator)",
            redirect: "Change the generator's input, then run the generator",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: "migrations/001.sql", change: "modify" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (modify) migrations/001.sql: the rule 'migrations/**' from bounded/project denies modify of 'migrations/001.sql' (applied migrations are history)",
            redirect: "Add a new migration instead",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: "migrations/001.sql", change: "delete" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (delete) migrations/001.sql: the rule 'migrations/**' from bounded/project denies delete of 'migrations/001.sql' (applied migrations are history)",
            redirect: "Add a new migration instead",
          },
        },
        { toolUse: { tool: "write", effects: [{ kind: "write", path: "generated/README.md", change: "modify" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "write", effects: [{ kind: "write", path: "migrations/002.sql", change: "create" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "write", effects: [{ kind: "write", path: "src/a.ts", change: "modify" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "write", effects: [{ kind: "write", path: ".pi/extensions/other/index.ts", change: "create" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "read", effects: [{ kind: "read", path: "generated/api.ts" }] }, verdict: { kind: "allow" } },
      ],
    },
  ],
});
