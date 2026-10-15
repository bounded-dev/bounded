import { defineConfig } from "bounded/domain";
import { refusingPack } from "refusing-package/refusing";

/**
 * Refuse every write
 *
 * The project selects the refusing pack.
 */
export default defineConfig({ packs: [refusingPack] });
