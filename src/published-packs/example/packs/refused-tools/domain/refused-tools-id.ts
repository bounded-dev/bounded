import { packIdsFor } from "bounded/domain";
import type { RefusedToolsId } from "./refused-tools-id.contract.ts";

export const refusedToolsId: RefusedToolsId = packIdsFor("bounded-example")("refused-tools");
