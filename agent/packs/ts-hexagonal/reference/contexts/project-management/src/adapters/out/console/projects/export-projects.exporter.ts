import type { ProjectExporter } from "@example/project-management/application";
import type { Project } from "@example/project-management/domain";

// Local stand-in for the S3 CSV exporter.
export class ConsoleProjectExporter implements ProjectExporter {
  async export(projects: Project[]): Promise<void> {
    console.table(projects.map((project) => project.toJSON()));
  }
}
