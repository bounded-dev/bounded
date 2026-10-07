import { composePacksCatalogConformance } from "../../../../application/composition/compose-packs/compose-packs.catalog.test-support.ts";
import { InMemoryComposePacksCatalog } from "./compose-packs.catalog.ts";

composePacksCatalogConformance("InMemoryComposePacksCatalog", async (packs) => new InMemoryComposePacksCatalog(packs));
