import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateProjectCommand,
  createProjectSchema,
  type CreateProject,
} from "@example/project-management/application";

export function registerCreateProjectTool(server: McpServer, createProject: CreateProject): void {
  server.registerTool(
    "create_project",
    { description: "Create a project", inputSchema: createProjectSchema.shape },
    async (input) => {
      const command = CreateProjectCommand.parse(input);
      if (!command.ok) return { isError: true, content: [{ type: "text", text: command.error }] };
      const project = await createProject.execute(command.value);
      return { content: [{ type: "text", text: JSON.stringify(project) }] };
    },
  );
}
