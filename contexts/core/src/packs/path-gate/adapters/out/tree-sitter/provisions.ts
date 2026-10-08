import { type PortProvision, Ports } from "bounded/domain";
import { shellParserPort } from "../../../application/judge-calls/judge-calls.contract.ts";
import { TreeSitterShellParser } from "./shell-parser.ts";

/** The path gate's shell parser, tree-sitter's bash grammar, for a host's composition root: a parser per project, the grammar loaded once per process. */
export function pathGateTreeSitter(): readonly PortProvision[] {
  return Object.freeze([Ports.provide(shellParserPort, () => new TreeSitterShellParser())]);
}
