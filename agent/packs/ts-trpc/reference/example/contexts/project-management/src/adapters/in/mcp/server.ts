import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreateProject, ListProjects } from "@example/project-management/application";
import { registerCreateProjectTool } from "./projects/create-project.tool.ts";
import { registerListProjectsTool } from "./projects/list-projects.tool.ts";

// The whole context's MCP surface. The transport (stdio, HTTP) is the app's choice.
export function createProjectManagementMcpServer(deps: { createProject: CreateProject; listProjects: ListProjects }) {
  const server = new McpServer({ name: "project-management", version: "0.1.0" });
  registerCreateProjectTool(server, deps.createProject);
  registerListProjectsTool(server, deps.listProjects);
  return server;
}
