// A handler has exactly the shape its generated skeleton gave it (TN-26-012
// §5; docs/architecture/application.md, Handlers): one exported class
// `<InPort>Handler implements <InPort>`, its out ports taken in the
// constructor as `private readonly <role>: <Port>`, `execute` as its one
// public method, and types from its own contract, never from the command
// file. Tests construct handlers by that shape before the body exists.

import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { pascalCase, portRole } from "../../../ts/scripts/naming.ts";
import { KEBAB, PASCAL } from "../../scripts/grammar.ts";
import { hexFile } from "../hexagonal.ts";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

type MessageId = "exports" | "implements" | "parameter" | "member" | "execute" | "command";

export const handlerShape = createRule<[], MessageId>({
  name: "handler-shape",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      exports: "A handler file exports exactly one thing, `export class {{handler}} implements {{port}}`; move '{{what}}' elsewhere.",
      implements: "{{handler}} must be declared `export class {{handler}} implements {{port}}` (the in port from ./{{feature}}.contract.ts).",
      parameter: "Constructor parameter '{{text}}' must be `private readonly <role>: <OutPort>`, the role being the port " +
        "name's last word lowercased (e.g. `private readonly store: {{port}}Store`). Out ports come in declaration order.",
      member: "'{{name}}' is public; a handler's only public member besides the constructor is execute. Make helpers private.",
      execute: "{{handler}} must implement `execute`, its one public method.",
      command: "A handler imports its types from ./{{feature}}.contract.ts, never from the command file.",
    },
  },
  defaultOptions: [],
  create(context) {
    const file = hexFile(context.filename, context.cwd);
    if (file === undefined || file.location.workspace !== "context" || file.location.layer !== "application") return {};
    const inner = file.location.inner;
    const feature = inner[2];
    if (inner.length !== 4 || feature === undefined || !KEBAB.test(feature) || inner[3] !== `${feature}.handler.ts`) return {};
    const port = pascalCase(feature);
    const handler = `${port}Handler`;
    const data = { handler, port, feature };

    const checkClass = (node: TSESTree.ClassDeclaration): void => {
      const implemented = node.implements.some((i) => i.expression.type === "Identifier" && i.expression.name === port);
      if (node.id?.name !== handler || !implemented || node.superClass !== null) {
        context.report({ node: node.id ?? node, messageId: "implements", data });
      }
      let hasExecute = false;
      for (const member of node.body.body) {
        if (member.type === "MethodDefinition" && member.kind === "constructor") {
          for (const param of member.value.params) checkParameter(param);
          continue;
        }
        if (member.type === "StaticBlock") {
          context.report({ node: member, messageId: "member", data: { name: "static block" } });
          continue;
        }
        if (!("key" in member)) continue;
        const name = member.key.type === "Identifier" ? member.key.name : member.key.type === "PrivateIdentifier" ? `#${member.key.name}` : "(computed)";
        const isPrivate = member.key.type === "PrivateIdentifier" || member.accessibility === "private";
        if (name === "execute" && member.type === "MethodDefinition" && !member.static && !isPrivate) {
          hasExecute = true;
          continue;
        }
        if (!isPrivate || member.static) context.report({ node: member, messageId: "member", data: { name } });
      }
      if (!hasExecute) context.report({ node: node.id ?? node, messageId: "execute", data });
    };

    const checkParameter = (param: TSESTree.Parameter): void => {
      const text = context.sourceCode.getText(param);
      if (param.type !== "TSParameterProperty" || param.accessibility !== "private" || !param.readonly ||
          param.override || param.static || param.parameter.type !== "Identifier") {
        context.report({ node: param, messageId: "parameter", data: { text, port } });
        return;
      }
      const annotation = param.parameter.typeAnnotation?.typeAnnotation;
      const typeName = annotation?.type === "TSTypeReference" && annotation.typeName.type === "Identifier" &&
        annotation.typeArguments === undefined ? annotation.typeName.name : undefined;
      if (typeName === undefined || !PASCAL.test(typeName) || param.parameter.name !== portRole(typeName) ||
          param.parameter.optional) {
        context.report({ node: param, messageId: "parameter", data: { text, port } });
      }
    };

    return {
      ImportDeclaration(node): void {
        if (/\.command(\.[cm]?[jt]s)?$/.test(node.source.value)) context.report({ node, messageId: "command", data });
      },
      ExportNamedDeclaration(node): void {
        if (node.source !== null || node.declaration === null) {
          context.report({ node, messageId: "exports", data: { ...data, what: context.sourceCode.getText(node).slice(0, 40) } });
          return;
        }
        if (node.declaration.type === "ClassDeclaration") {
          checkClass(node.declaration);
          return;
        }
        context.report({ node, messageId: "exports", data: { ...data, what: context.sourceCode.getText(node).slice(0, 40) } });
      },
      ExportDefaultDeclaration(node): void {
        context.report({ node, messageId: "exports", data: { ...data, what: "export default" } });
      },
      ExportAllDeclaration(node): void {
        context.report({ node, messageId: "exports", data: { ...data, what: context.sourceCode.getText(node).slice(0, 40) } });
      },
      "Program:exit"(node): void {
        const exported = node.body.some((s) => s.type === "ExportNamedDeclaration" && s.declaration?.type === "ClassDeclaration");
        if (!exported) context.report({ node, messageId: "implements", data });
      },
    };
  },
});
