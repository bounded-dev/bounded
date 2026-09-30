import { composeExportProjects } from "./composition-root.ts";

// Built once per cold start, reused across invocations.
export const handler = composeExportProjects();
