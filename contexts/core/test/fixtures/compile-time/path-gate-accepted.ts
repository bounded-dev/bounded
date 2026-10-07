// The legitimate forms of path rules. Compiles without errors.
import { contribution, definePack } from "bounded/domain";
import { pathGate, type ProtectedPath, writes } from "bounded/path-gate";
import { packId } from "./packs.ts";

const generated: ProtectedPath = { match: "packages/db/**", except: ["packages/db/src/schema/**"], deny: [...writes], redirect: "Edit the schema instead", why: "generated" };

export const project = definePack({
  id: packId("project"),
  dependsOn: [pathGate],
  contributes: [
    contribution(pathGate.points.protectedPaths, [
      generated,
      { match: "**/.env*", deny: ["read", ...writes], redirect: "Ask a maintainer for the value" },
      { match: "infra/**", deny: ["delete"], redirect: "Open a change for the platform team" },
    ]),
  ],
});
