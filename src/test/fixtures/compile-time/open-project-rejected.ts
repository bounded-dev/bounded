// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
import { openProject } from "bounded/open-project";

// A host opens a project with the ports its packs need, or with no options at
// all; it builds each command's reading itself, with bounded's reader, and
// puts it on the execute effect (ADR 2026-020). openProject takes no reader.
export const withoutOptions = openProject("/p");
export const withPorts = openProject("/p", { ports: [] });
export const withReader = openProject("/p", { ports: [], shellCommandReader: {} }); // rejected: 'shellCommandReader' does not exist in type
