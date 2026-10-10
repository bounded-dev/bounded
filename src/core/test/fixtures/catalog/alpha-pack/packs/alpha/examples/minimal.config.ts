import { defineConfig } from "bounded/domain";
import { alphaPack } from "demo-package/alpha";

/**
 * Select the alpha pack
 *
 * The project selects the pack, which brings in the core.
 */
export default defineConfig({ packs: [alphaPack] });
