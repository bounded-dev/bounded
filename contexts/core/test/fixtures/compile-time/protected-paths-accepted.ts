// The legitimate forms of path rules. Compiles without errors.
import { contribution, defineConfig, definePack } from "bounded/domain";
import { protectedPathsPack, type ProtectedPathJSON } from "bounded/protected-paths";
import { packId } from "./packs.ts";

// A rule is written as its wire form, an object literal; the point's check makes the ProtectedPath.
const generated: ProtectedPathJSON = { match: "packages/db/**", except: ["packages/db/src/schema/**"], deny: ["create", "modify", "delete"], redirect: "Edit the schema instead", why: "generated" };

export const project = definePack({
  id: packId("project"),
  dependsOn: [protectedPathsPack],
  contributes: [
    contribution(protectedPathsPack.points.protectedPaths, [
      generated,
      { match: "**/.env*", deny: ["read", "create", "modify", "delete"], redirect: "Ask a maintainer for the value" },
      { match: "infra/**", deny: ["delete"], redirect: "Open a change for the platform team" },
    ]),
  ],
});

// A configuration that lists only the protected-paths pack: the protected-paths pack brings in the core.
export const protectedPathsOnly = defineConfig({ packs: [protectedPathsPack], contributes: [contribution(protectedPathsPack.points.protectedPaths, [generated])] });
