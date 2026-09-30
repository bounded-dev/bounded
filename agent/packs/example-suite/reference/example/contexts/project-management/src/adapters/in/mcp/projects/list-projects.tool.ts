import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListProjects } from "@example/project-management/application";

export function registerListProjectsTool(server: McpServer, listProjects: ListProjects): void {
  server.registerTool("list_projects", { description: "List all projects" }, async () => {
    const projects = await listProjects.execute();
    return { content: [{ type: "text", text: JSON.stringify(projects) }] };
  });
}
