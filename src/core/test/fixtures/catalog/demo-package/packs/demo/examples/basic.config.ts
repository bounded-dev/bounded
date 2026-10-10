import { contribution, defineConfig } from "bounded/domain";
import { demoPack } from "demo-package/demo";

/**
 * Keep a note
 *
 * The project keeps one note for its agents: where plans live.
 */
export default defineConfig({
  packs: [demoPack],
  contributes: [contribution(demoPack.points.notes, [{ text: "Plans live in .agent-state/" }])],
});
