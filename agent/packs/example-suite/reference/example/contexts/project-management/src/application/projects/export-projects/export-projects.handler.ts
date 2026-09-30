import type { ExportProjects, ExportProjectsStore, ProjectExporter } from "./export-projects.contract.ts";

export class ExportProjectsHandler implements ExportProjects {
  constructor(
    private readonly store: ExportProjectsStore,
    private readonly exporter: ProjectExporter,
  ) {}

  async execute(): Promise<void> {
    await this.exporter.export(await this.store.findAll());
  }
}
