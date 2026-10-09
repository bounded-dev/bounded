import { packIdsFor } from "bounded/domain";
import type { ProtectedPathsId } from "./protected-paths-id.contract.ts";

export const protectedPathsId: ProtectedPathsId = packIdsFor("bounded")("protected-paths");
