import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ToolName } from "./tool-name.ts";

valueObjectLaws("ToolName", ToolName, ["mcp__docs__search", "web_search"], ["", " ", "a\u0000b"]);
textValueLaws("ToolName", ToolName, [["mcp__docs__search", "mcp__docs__search"]]);
