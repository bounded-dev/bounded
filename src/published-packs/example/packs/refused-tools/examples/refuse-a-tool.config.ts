import { contribution, defineConfig } from "bounded/domain";
import { refusedToolsPack } from "bounded-example";

/**
 * Keep a session offline
 *
 * For a session that must stay offline: no web tool is used, and agents
 * are pointed at the documentation the project keeps in its repository.
 */
export default defineConfig({
  packs: [refusedToolsPack],
  contributes: [contribution(refusedToolsPack.points.refusedTools, [{ tool: "web", redirect: "Read the project's docs in docs/ instead; ask a person for anything they do not cover" }])],
});
