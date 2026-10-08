import { shellParserConformance } from "../../../application/judge-calls/judge-calls.shell-parser.test-support.ts";
import { TreeSitterShellParser } from "./shell-parser.ts";

shellParserConformance("TreeSitterShellParser", async () => new TreeSitterShellParser());
