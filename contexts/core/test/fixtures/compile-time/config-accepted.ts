// The legitimate forms of a project configuration. Compiles without errors.
import { contribution, corePack, defineConfig } from "bounded/domain";
import { base, tags } from "./packs.ts";

export default defineConfig({
  packs: [corePack, base, tags],
  contributes: [contribution(base.points.words, ["project word"]), contribution(tags.points.names, ["project tag"])],
});
export const minimal = defineConfig({ packs: [corePack] });
