import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { handlerShape } from "./handler-shape.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const FILE = "contexts/project-management/src/application/projects/export-projects/export-projects.handler.ts";
const IMPORTS = `import type { ExportProjects, ExportProjectsStore, ProjectExporter } from "./export-projects.contract.ts";\n`;
const handler = (body: string, header = "export class ExportProjectsHandler implements ExportProjects") =>
  `${IMPORTS}${header} {\n${body}\n}\n`;
const CTOR = "  constructor(\n    private readonly store: ExportProjectsStore,\n    private readonly exporter: ProjectExporter,\n  ) {}";
const EXECUTE = "  async execute(): Promise<void> {\n    await this.exporter.export(await this.store.findAll());\n  }";
type Id = "exports" | "implements" | "parameter" | "member" | "execute" | "command";
const bad = (code: string, ...ids: Id[]) => ({ code, filename: FILE, errors: ids.map((messageId) => ({ messageId })) });

ruleTester.run("handler-shape", handlerShape, {
  valid: [
    { code: handler(`${CTOR}\n\n${EXECUTE}`), filename: FILE },
    // The generated skeleton itself.
    {
      code: `import { NotImplementedError } from "../../../domain/shared/errors.ts";\n${handler(
        `${CTOR}\n\n  async execute(): Promise<void> {\n    throw new NotImplementedError("ExportProjectsHandler.execute");\n  }`)}`,
      filename: FILE,
    },
    // No out ports, no constructor.
    { code: handler(EXECUTE), filename: FILE },
    // Private helpers, in both spellings.
    { code: handler(`${CTOR}\n\n${EXECUTE}\n\n  private sorted(): void {}\n\n  #count = 0;`), filename: FILE },
    // A non-async pass-through execute is the same signature.
    { code: handler("  execute(): Promise<void> {\n    return Promise.resolve();\n  }"), filename: FILE },
    // Not a handler file: nothing to check.
    { code: "export const x = 1;", filename: "contexts/project-management/src/application/projects/export-projects/export-projects.command.ts" },
    { code: "export class Whatever {}", filename: "apps/web/src/server/main.ts" },
  ],
  invalid: [
    bad(handler(`${CTOR}\n\n${EXECUTE}`, "export class ExportProjectsHandler"), "implements"),
    bad(handler(`${CTOR}\n\n${EXECUTE}`, "export class ExportProjectsHandler implements ExportProject"), "implements"),
    bad(handler(`${CTOR}\n\n${EXECUTE}`, "export class ExportHandler implements ExportProjects"), "implements"),
    bad(handler(`${CTOR}\n\n${EXECUTE}`, "export class ExportProjectsHandler extends Base implements ExportProjects"), "implements"),
    bad(handler(`${CTOR}\n\n${EXECUTE}`) + "export const helper = 1;\n", "exports"),
    bad(handler(`${CTOR}\n\n${EXECUTE}`) + "export { x } from './x.ts';\n", "exports"),
    bad(handler(`${CTOR}\n\n${EXECUTE}`) + "export default 1;\n", "exports"),
    bad(`${IMPORTS}class ExportProjectsHandler implements ExportProjects {\n${EXECUTE}\n}\nexport { ExportProjectsHandler };\n`, "implements", "exports"),
    bad(handler(`  constructor(private store: ExportProjectsStore) {}\n\n${EXECUTE}`), "parameter"),
    bad(handler(`  constructor(readonly store: ExportProjectsStore) {}\n\n${EXECUTE}`), "parameter"),
    bad(handler(`  constructor(public readonly store: ExportProjectsStore) {}\n\n${EXECUTE}`), "parameter"),
    bad(handler(`  constructor(store: ExportProjectsStore) {}\n\n${EXECUTE}`), "parameter"),
    bad(handler(`  constructor(private readonly db: ExportProjectsStore) {}\n\n${EXECUTE}`), "parameter"),
    bad(handler(`  constructor(private readonly store?: ExportProjectsStore) {}\n\n${EXECUTE}`), "parameter"),
    bad(handler(`  constructor(private readonly store: Partial<ExportProjectsStore>) {}\n\n${EXECUTE}`), "parameter"),
    bad(handler(`${CTOR}\n\n${EXECUTE}\n\n  helper(): void {}`), "member"),
    bad(handler(`${CTOR}\n\n${EXECUTE}\n\n  public count = 0;`), "member"),
    bad(handler(`${CTOR}\n\n${EXECUTE}\n\n  static create(): void {}`), "member"),
    bad(handler(`${CTOR}\n\n${EXECUTE}\n\n  private static cache = 1;`), "member"),
    bad(handler(CTOR), "execute"),
    bad(handler(`${CTOR}\n\n  private execute(): Promise<void> { return Promise.resolve(); }`), "execute"),
    bad(`import { ExportProjectsCommand } from "./export-projects.command.ts";\n${handler(`${CTOR}\n\n${EXECUTE}`)}`, "command"),
    bad(`${IMPORTS}export const ExportProjectsHandler = 1;\n`, "implements", "exports"),
  ],
});
