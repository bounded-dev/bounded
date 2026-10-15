import { defineExampleScenarios } from "bounded/domain";

export default defineExampleScenarios({
  scenarios: [
    {
      title: "Environment files, private keys and secrets/ are neither read, listed nor written; .env.example and a filtered search that cannot reach secrets/ stay allowed",
      projectFiles: {
        ".env": "TOKEN=1\n",
        ".env.example": "TOKEN=\n",
        "app/.env": "TOKEN=2\n",
        "certs/server.pem": "-----BEGIN PRIVATE KEY-----\n",
        "secrets/db.txt": "password\n",
        "src/a.ts": "export const a = 1;\n",
      },
      steps: [
        {
          toolUse: { tool: "read", effects: [{ kind: "read", path: ".env" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused read .env: the rule '**/.env' from bounded/project denies read of '.env' (environment files hold credentials)",
            redirect: "Ask a maintainer for the value you need; .env.example names every variable",
          },
        },
        {
          toolUse: { tool: "read", effects: [{ kind: "read", path: "app/.env" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused read app/.env: the rule '**/.env' from bounded/project denies read of 'app/.env' (environment files hold credentials)",
            redirect: "Ask a maintainer for the value you need; .env.example names every variable",
          },
        },
        {
          toolUse: { tool: "write", effects: [{ kind: "write", path: ".env.local", change: "create" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused write (create) .env.local: the rule '**/.env.local' from bounded/project denies create of '.env.local' (environment files hold credentials)",
            redirect: "Ask a maintainer for the value you need; .env.example names every variable",
          },
        },
        {
          toolUse: { tool: "read", effects: [{ kind: "read", path: "certs/server.pem" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused read certs/server.pem: the rule '**/*.pem' from bounded/project denies read of 'certs/server.pem' (private keys stay with people)",
            redirect: "Ask a maintainer to run the step that needs the key",
          },
        },
        {
          toolUse: { tool: "read", effects: [{ kind: "read", path: "secrets/db.txt" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused read secrets/db.txt: the rule 'secrets' from bounded/project denies read of 'secrets/db.txt' (secrets are kept by people)",
            redirect: "Ask a maintainer for the value you need",
          },
        },
        {
          toolUse: { tool: "search", effects: [{ kind: "list", root: "secrets" }] },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused list secrets: the rule 'secrets' from bounded/project denies list, and listing 'secrets' could reveal a path it matches (secrets are kept by people)",
            redirect: "List a root outside 'secrets' — Ask a maintainer for the value you need",
          },
        },
        {
          toolUse: {
            tool: "search",
            effects: [
              { kind: "list", root: ".", filter: "*.ts" },
              { kind: "read", path: "." },
            ],
          },
          verdict: {
            kind: "refuse",
            reason: "bounded/protected-paths refused list . (*.ts): the rule 'secrets' from bounded/project denies list, and listing '.' could reveal a path it matches (secrets are kept by people)",
            redirect: "List a narrower path (not the whole project) that cannot reach 'secrets' — Ask a maintainer for the value you need",
          },
        },
        { toolUse: { tool: "read", effects: [{ kind: "read", path: ".env.example" }] }, verdict: { kind: "allow" } },
        { toolUse: { tool: "read", effects: [{ kind: "read", path: "src/a.ts" }] }, verdict: { kind: "allow" } },
        {
          toolUse: {
            tool: "search",
            effects: [
              { kind: "list", root: "src", filter: "*.ts" },
              { kind: "read", path: "src" },
            ],
          },
          verdict: { kind: "allow" },
        },
      ],
    },
  ],
});
