// Every line of code marked `// rejected: <reason>` must fail to compile with
// an error whose message contains <reason>, and no other line may fail.
import type { ShellCommandReader } from "bounded/application";
import { openProject } from "bounded/open-project";

declare const shellCommandReader: ShellCommandReader;

// A host opens a project with a shell command reader: without one, every shell command would be refused.
export const withReader = openProject("/p", { ports: [], shellCommandReader });
export const withoutReader = openProject("/p", { ports: [] }); // rejected: Property 'shellCommandReader' is missing
