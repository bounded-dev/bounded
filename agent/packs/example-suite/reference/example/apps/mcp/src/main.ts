import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { composeApp } from "./composition-root.ts";

await composeApp().connect(new StdioServerTransport());
