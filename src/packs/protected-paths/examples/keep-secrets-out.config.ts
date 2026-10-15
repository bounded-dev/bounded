import { contribution, defineConfig } from "bounded/domain";
import { protectedPathsPack } from "bounded/protected-paths";

/**
 * Keep secrets out of the agent's reach
 *
 * For a project that keeps credentials in its tree: agents are kept away
 * from its environment files, private keys and `secrets/`.
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
