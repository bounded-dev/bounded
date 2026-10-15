import { contribution, defineConfig } from "bounded/domain";
import { refusedToolsPack } from "bounded-example";

/**
 * Keep a session offline
 *
 * Every web tool use (fetching a page, searching the web) is refused, with
 * a pointer to the documentation the project keeps in its repository.
 */
export default defineConfig({
  packs: [refusedToolsPack],
  contributes: [contribution(refusedToolsPack.points.refusedTools, [{ tool: "web", redirect: "Read the project's docs in docs/ instead; ask a person for anything they do not cover" }])],
});
