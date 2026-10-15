import { contribution, defineConfig } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";

/**
 * Keep secrets out of the agent's reach
 *
 * Agents may not read, create, change or delete the project's environment
 * files and private keys, nor anything under `secrets/`. A file rule
 * (`file: true`) covers the named file alone, so a search filtered to other
 * names (`*.ts`) is still allowed where it cannot reach `secrets/`, such as
 * under `src/`. The example file that lists the variables' names stays
 * readable.
 */
export default defineConfig({
  packs: [protectedPathsPack],
  contributes: [
    contribution(protectedPathsPack.points.protectedPaths, [
      {
        match: "**/.env",
        file: true,
        deny: ["read", "create", "modify", "delete"],
        why: "environment files hold credentials",
        redirect: "Ask a maintainer for the value you need; .env.example names every variable",
      },
      {
        match: "**/.env.local",
        file: true,
        deny: ["read", "create", "modify", "delete"],
        why: "environment files hold credentials",
        redirect: "Ask a maintainer for the value you need; .env.example names every variable",
      },
      {
        match: "**/*.pem",
        deny: ["read", "create", "modify", "delete"],
        why: "private keys stay with people",
        redirect: "Ask a maintainer to run the step that needs the key",
      },
      {
        match: "secrets",
        deny: ["read", "list", "create", "modify", "delete"],
        why: "secrets are kept by people",
        redirect: "Ask a maintainer for the value you need",
      },
    ]),
  ],
});
