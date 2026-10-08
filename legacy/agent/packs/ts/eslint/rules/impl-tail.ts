import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// ADR 2026-059 implementation rule: a concept's implementation file hides its
// class and ends with the two exports the emitter generated, byte for byte.
//
//   import type * as Contract from "./note-text.contract.ts";
//
//   class NoteTextImpl implements Contract.NoteText { … }         // not exported
//
//   export type NoteText = Contract.NoteText;
//   export const NoteText: Contract.NoteTextFactory = NoteTextImpl;
//
// Why each part is held (domain.md, "Contracts own the name"):
//
// * `<Name>Impl` is never exported: consumers reach the concept only through
//   the one name the contract owns, so no second identity can leak.
// * `implements Contract.<Name>` checks the instance side against the
//   contract, and the `const` annotation `Contract.<Name>Factory` checks the
//   static side. Remove either and the compiler stops checking that half.
// * `import type * as Contract` imports the contract as a namespace, so
//   nothing is aliased and `<Name>` stays free for the tail to export.
// * The tail is the file's last two statements, exactly as generated. The
//   builder writes the class body; the tail is not theirs to vary.
//
// TRIGGER (any of): a top-level class named `…Impl`; an
// `import … * as Contract`; or a file `<stem>.ts` that imports its own
// `./<stem>.contract.ts`. Any one of those says "this is a concept
// implementation", and then every requirement applies. The contract module
// is `./<first dotted segment of the file name>.contract.ts`
// (`note-text.ts` → `./note-text.contract.ts`; `create-note.command.ts` →
// `./create-note.contract.ts`). A file implementing its OWN contract
// (`<stem>.ts`) exports nothing but the tail; a generated command file may
// also export its wire schema.

type MessageId =
  | "implCount"
  | "implExported"
  | "implements"
  | "contractImport"
  | "tail"
  | "extraExport";

const WHY = "A concept's implementation hides '<Name>Impl' and ends with exactly the two generated exports (ADR 2026-059, domain.md \"Contracts own the name\").";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

function baseName(filename: string): string {
  return filename.replace(/\\/g, "/").split("/").pop() ?? "";
}

/** `note-text.ts` → `note-text`; `create-note.command.ts` → `create-note`. */
function ownerStem(filename: string): string {
  return baseName(filename).split(".")[0] ?? "";
}

function isContractNamespaceImport(node: TSESTree.ProgramStatement): node is TSESTree.ImportDeclaration {
  return node.type === TSESTree.AST_NODE_TYPES.ImportDeclaration &&
    node.specifiers.some((s) => s.type === TSESTree.AST_NODE_TYPES.ImportNamespaceSpecifier && s.local.name === "Contract");
}

function exportedNames(stmt: TSESTree.ProgramStatement): string[] {
  if (stmt.type === TSESTree.AST_NODE_TYPES.ExportDefaultDeclaration) return ["default"];
  if (stmt.type === TSESTree.AST_NODE_TYPES.ExportAllDeclaration) return ["*"];
  if (stmt.type !== TSESTree.AST_NODE_TYPES.ExportNamedDeclaration) return [];
  const decl = stmt.declaration;
  if (decl === null || decl === undefined) {
    return stmt.specifiers.map((s) => (s.exported.type === TSESTree.AST_NODE_TYPES.Identifier ? s.exported.name : String(s.exported.value)));
  }
  if (decl.type === TSESTree.AST_NODE_TYPES.VariableDeclaration) {
    return decl.declarations.map((d) => (d.id.type === TSESTree.AST_NODE_TYPES.Identifier ? d.id.name : "?"));
  }
  return "id" in decl && decl.id !== null && decl.id.type === TSESTree.AST_NODE_TYPES.Identifier ? [decl.id.name] : ["?"];
}

export const implTail = createRule<[], MessageId>({
  name: "impl-tail",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      implCount: `${WHY} This file declares {{count}} '…Impl' classes — a concept implementation holds exactly one, '<Name>Impl', named after the concept it implements.`,
      implExported: `${WHY} '{{impl}}' is exported — remove the export. Consumers use '{{name}}', which the tail exports as both the type and the value.`,
      implements: `${WHY} '{{impl}}' must be declared 'class {{impl}} implements Contract.{{name}} {' with no 'extends' — the implements clause is what checks the instance side against the contract.`,
      contractImport: `${WHY} Import the contract as a namespace, exactly 'import type * as Contract from "{{specifier}}";' — found {{found}}.`,
      tail: `${WHY} The file must end with exactly these two lines, as generated:\n{{tail}}\nThe type alias makes '{{name}}' the contract's interface; the annotated const checks the static side against '{{name}}Factory'. Write the class body above them and leave the tail as it is.`,
      extraExport: `${WHY} '{{exported}}' is exported beside the tail — this file implements its own contract and exports only '{{name}}' (the tail). Move shared helpers into their own module, or make them private to the class.`,
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;
    const stem = ownerStem(filename);
    const ownContract = `./${stem}.contract.ts`;
    const ownImplementation = baseName(filename) === `${stem}.ts`;
    const sourceCode = context.sourceCode;

    return {
      Program(program) {
        const body = program.body;
        const implOf = (stmt: TSESTree.ProgramStatement): TSESTree.ClassDeclaration | undefined => {
          const decl = stmt.type === TSESTree.AST_NODE_TYPES.ExportNamedDeclaration ||
            stmt.type === TSESTree.AST_NODE_TYPES.ExportDefaultDeclaration
            ? stmt.declaration
            : stmt;
          return decl?.type === TSESTree.AST_NODE_TYPES.ClassDeclaration && decl.id !== null && /.Impl$/.test(decl.id.name)
            ? decl
            : undefined;
        };
        const impls = body.flatMap((s) => {
          const c = implOf(s);
          return c === undefined ? [] : [{ stmt: s, cls: c }];
        });
        const namespaceImports = body.filter(isContractNamespaceImport);
        const importsOwnContract = body.some(
          (s) => s.type === TSESTree.AST_NODE_TYPES.ImportDeclaration && s.source.value === ownContract,
        );
        if (impls.length === 0 && namespaceImports.length === 0 && !(ownImplementation && importsOwnContract)) return;

        if (impls.length !== 1) {
          context.report({ node: impls[1]?.cls ?? program, messageId: "implCount", data: { count: String(impls.length) } });
          return;
        }
        const { stmt, cls } = impls[0]!;
        const impl = cls.id!.name;
        const name = impl.slice(0, -"Impl".length);

        if (stmt !== cls) context.report({ node: stmt, messageId: "implExported", data: { impl, name } });
        for (const s of body) {
          if (s.type === TSESTree.AST_NODE_TYPES.ExportNamedDeclaration && s.declaration === null &&
              s.specifiers.some((sp) => sp.local.type === TSESTree.AST_NODE_TYPES.Identifier && sp.local.name === impl)) {
            context.report({ node: s, messageId: "implExported", data: { impl, name } });
          }
        }

        const implementsOk = cls.superClass === null && cls.implements.length === 1 &&
          sourceCode.getText(cls.implements[0]!) === `Contract.${name}`;
        if (!implementsOk) context.report({ node: cls.id!, messageId: "implements", data: { impl, name } });

        const exact = namespaceImports.length === 1 && sourceCode.getText(namespaceImports[0]!) ===
          `import type * as Contract from "${ownContract}";`;
        if (!exact) {
          const found = namespaceImports.length === 0
            ? "none"
            : namespaceImports.map((n) => `'${sourceCode.getText(n)}'`).join(", ");
          context.report({
            node: namespaceImports[0] ?? cls.id!,
            messageId: "contractImport",
            data: { specifier: ownContract, found },
          });
        }

        const tailLines = [
          `export type ${name} = Contract.${name};`,
          `export const ${name}: Contract.${name}Factory = ${impl};`,
        ];
        const last = body.slice(-2).map((s) => sourceCode.getText(s));
        if (body.length < 2 || last[0] !== tailLines[0] || last[1] !== tailLines[1]) {
          context.report({ node: body.at(-1) ?? program, messageId: "tail", data: { tail: tailLines.join("\n"), name } });
        }

        // A tail line out of place is the `tail` report's business; do not
        // report the same statement again as an extra export.
        const tailStatements = new Set([
          ...body.slice(-2),
          ...body.filter((s) => tailLines.includes(sourceCode.getText(s))),
        ]);
        for (const s of body) {
          if (tailStatements.has(s) || s === stmt) continue;
          for (const exported of exportedNames(s)) {
            if (exported === impl) continue;
            if (ownImplementation || exported === name || exported === "default" || exported === "*") {
              context.report({ node: s, messageId: "extraExport", data: { exported, name } });
            }
          }
        }
      },
    };
  },
});
