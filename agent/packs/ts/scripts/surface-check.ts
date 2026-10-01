// surface-check (TN-26-001, ADR 2026-059): keeps a delivered project's public
// surface exactly what its contracts declare, long after the harness is gone.
//
//   bun scripts/surface-check.ts [projectRoot [sourceRoot…]]
//
// With no source roots given, they are read from the root package.json: every
// `<dir>/*` workspace glob contributes `<dir>/*/src` (the hexagonal monorepo,
// TN-26-012), and a project with no workspaces uses `src`.
//
// The compiler already checks most of the contract: a concept's
// implementation ends with `export const <Name>: Contract.<Name>Factory =
// <Name>Impl`, and a class `implements` its contract interface. What the
// compiler cannot see is surface ADDED beside what the contract declares, or
// the checking line itself edited away. Those are this gate's:
//
//   concept   `<area>/<concept>.contract.ts` (an interface `<Name>` with a
//             `__brand`, and `<Name>Factory`) is implemented by
//             `<concept>.ts`, which must end with exactly the two generated
//             exports and export nothing else (Run 8 shipped an undeclared
//             public `Money.signed` this way).
//   feature   `<feature>/<feature>.contract.ts` (an in port with `execute`)
//             is implemented by `<feature>.handler.ts`, which must export
//             exactly one class, `<InPort>Handler implements <InPort>`, whose
//             only public members are its constructor and `execute`.
//
// Every other contract (shared port types) declares types only, and the
// compiler checks every use of them.
//
// Exit 0 clean · 1 violations (one greppable line each) · 2 misuse (no
// contracts found / a contract with no implementation file).
//
// DUAL-USE — DO NOT ADD PACK OR HARNESS IMPORTS. This file is copied VERBATIM
// into generated projects (`check:surface`). It must import ONLY "ts-morph"
// and node builtins.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Project, type SourceFile } from "ts-morph";

export type ViolationKind =
  | "concept-tail"
  | "undeclared-export"
  | "handler-shape"
  | "undeclared-member";

export interface SurfaceViolation {
  /** Project-relative implementation file. */
  readonly file: string;
  readonly exportName: string;
  readonly kind: ViolationKind;
  readonly message: string;
}

const DISPUTE = "a contract change is the architect's, through CONTRACT-DISPUTE";

// --- concepts (ADR 2026-059) -------------------------------------------------------

/** The concept a contract declares, or undefined. */
export function conceptNameOf(contract: SourceFile): string | undefined {
  const exported = contract.getInterfaces().filter((i) => i.isExported());
  for (const iface of exported) {
    const name = iface.getName();
    if (iface.getProperty("__brand") !== undefined && exported.some((f) => f.getName() === `${name}Factory`)) return name;
  }
  return undefined;
}

function conceptViolations(name: string, contractFileName: string, impl: SourceFile, implFileName: string): SurfaceViolation[] {
  const out: SurfaceViolation[] = [];
  const tail = [`export type ${name} = Contract.${name};`, `export const ${name}: Contract.${name}Factory = ${name}Impl;`];
  const last = impl.getStatements().slice(-2).map((st) => st.getText());
  if (last[0] !== tail[0] || last[1] !== tail[1]) {
    out.push({
      file: implFileName,
      exportName: name,
      kind: "concept-tail",
      message: `${name}: ${implFileName} must end with exactly the two generated exports, which make ${contractFileName}'s interface the one type named ${name} and check ${name}Impl against ${name}Factory (ADR 2026-059):\n${tail.join("\n")}`,
    });
  }
  for (const [exported, declarations] of impl.getExportedDeclarations()) {
    if (exported === name) continue;
    const kind = declarations[0]?.getKindName() ?? "declaration";
    out.push({
      file: implFileName,
      exportName: exported,
      kind: "undeclared-export",
      message: `${exported}: the implementation exports ${kind} '${exported}', which ${contractFileName} does not declare — a concept's implementation exports only '${name}' (the tail); keep '${exported}' module-local or move it to its own module (${DISPUTE})`,
    });
  }
  return out;
}

// --- features (TN-26-012 §5) --------------------------------------------------------

/** The in port a feature contract declares (the interface with `execute`), or undefined. */
export function inPortNameOf(contract: SourceFile): string | undefined {
  return contract.getInterfaces().find((i) => i.isExported() && i.getMethod("execute") !== undefined)?.getName();
}

function handlerViolations(inPort: string, contractFileName: string, impl: SourceFile, implFileName: string): SurfaceViolation[] {
  const out: SurfaceViolation[] = [];
  const handler = `${inPort}Handler`;
  for (const [exported, declarations] of impl.getExportedDeclarations()) {
    if (exported === handler) continue;
    out.push({
      file: implFileName,
      exportName: exported,
      kind: "undeclared-export",
      message: `${exported}: ${implFileName} exports ${declarations[0]?.getKindName() ?? "declaration"} '${exported}', which ${contractFileName} does not declare — a handler file exports only ${handler}; keep '${exported}' module-local (${DISPUTE})`,
    });
  }
  const cls = impl.getClass(handler);
  if (cls === undefined || !cls.isExported()) {
    out.push({ file: implFileName, exportName: handler, kind: "handler-shape", message: `${handler}: ${implFileName} must export class ${handler} implementing ${inPort}` });
    return out;
  }
  if (!cls.getImplements().some((i) => i.getExpression().getText() === inPort)) {
    out.push({ file: implFileName, exportName: handler, kind: "handler-shape", message: `${handler}: it must declare \`implements ${inPort}\`, so the compiler holds it to ${contractFileName}'s in port` });
  }
  // Constructor parameter properties are members too: `constructor(readonly
  // store: X)` is a public `store`.
  for (const parameter of cls.getConstructors()[0]?.getParameters() ?? []) {
    if (!parameter.isParameterProperty()) continue;
    const scope = parameter.getScope();
    if (scope === "private" || scope === "protected") continue;
    out.push({
      file: implFileName,
      exportName: handler,
      kind: "undeclared-member",
      message: `${handler}.${parameter.getName()}: public member not declared by ${contractFileName} — a handler's only public member is execute; make it private (${DISPUTE})`,
    });
  }
  for (const member of cls.getMembers()) {
    if (Node.isConstructorDeclaration(member)) continue;
    const name = Node.isMethodDeclaration(member) || Node.isPropertyDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)
      ? member.getName()
      : member.getKindName();
    const scope = Node.isScoped(member) ? member.getScope() : undefined;
    const isPrivate = scope === "private" || scope === "protected" || name.startsWith("#");
    if (isPrivate || (name === "execute" && Node.isMethodDeclaration(member) && !member.isStatic())) continue;
    out.push({
      file: implFileName,
      exportName: handler,
      kind: "undeclared-member",
      message: `${handler}.${name}: public member not declared by ${contractFileName} — a handler's only public member is execute; make it private (${DISPUTE})`,
    });
  }
  return out;
}

/**
 * The violations of one contract/implementation pair. Pure: strings in,
 * violations out. A contract that is neither a concept nor a feature
 * declares types only and has no pair: none.
 */
export function compareSurfaces(contractSource: string, contractFileName: string, implSource: string, implFileName: string): SurfaceViolation[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const contract = project.createSourceFile("/__contract__.ts", contractSource);
  const impl = project.createSourceFile(implFileName.endsWith(".tsx") ? "/__impl__.tsx" : "/__impl__.ts", implSource);
  // A feature contract's Command is branded and has a factory too, so the
  // in port decides first.
  const inPort = inPortNameOf(contract);
  if (inPort !== undefined) return handlerViolations(inPort, contractFileName, impl, implFileName);
  const concept = conceptNameOf(contract);
  if (concept !== undefined) return conceptViolations(concept, contractFileName, impl, implFileName);
  return [];
}

/** The implementation file a contract is paired with, or undefined when it
 *  has none (a types-only contract). */
export function implementationOf(contractSource: string, contractRel: string): string | undefined {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const contract = project.createSourceFile("/__contract__.ts", contractSource);
  const stem = contractRel.slice(0, -CONTRACT_SUFFIX.length);
  if (inPortNameOf(contract) !== undefined) return `${stem}.handler.ts`;
  if (conceptNameOf(contract) !== undefined) return `${stem}.ts`;
  return undefined;
}

// --- project walk (IO wrapper) --------------------------------------------------

const CONTRACT_SUFFIX = ".contract.ts";

function walkContracts(root: string, dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkContracts(root, full, out);
    else if (entry.name.endsWith(CONTRACT_SUFFIX)) out.push(relative(root, full).split(sep).join("/"));
  }
  return out.sort();
}

export interface SurfaceCheckRun {
  readonly code: 0 | 1 | 2;
  readonly lines: readonly string[];
  readonly violations: readonly SurfaceViolation[];
}

/** The concrete directories a source-root glob names: each segment literal
 *  or exactly `*` (one directory level). Sorted; directories only. */
function expandRoot(root: string, glob: string): string[] {
  let dirs = [""];
  for (const segment of glob.split("/")) {
    const next: string[] = [];
    for (const dir of dirs) {
      if (segment !== "*") {
        const candidate = dir === "" ? segment : `${dir}/${segment}`;
        if (existsSync(join(root, candidate))) next.push(candidate);
        continue;
      }
      const abs = join(root, dir);
      if (!existsSync(abs)) continue;
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          next.push(dir === "" ? entry.name : `${dir}/${entry.name}`);
        }
      }
    }
    dirs = next;
  }
  return dirs.sort();
}

/** Every concrete directory the source-root globs name under `root`. */
export function expandSourceRoots(root: string, globs: readonly string[]): string[] {
  return [...new Set(globs.flatMap((glob) => expandRoot(root, glob)))].sort();
}

/** The source roots a project's own manifest implies: `<dir>/*\/src` per
 *  `<dir>/*` workspace glob, else `src`. */
export function manifestSourceRoots(root: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: unknown };
    const globs = Array.isArray(manifest.workspaces) ? manifest.workspaces.filter((w): w is string => typeof w === "string" && /^[a-z0-9-]+\/\*$/.test(w)) : [];
    return globs.length > 0 ? globs.map((g) => `${g}/src`) : ["src"];
  } catch {
    return ["src"];
  }
}

/** Every contract under the source roots, checked against its
 *  implementation. One verdict for the CLI and the gate wrappers alike. */
export function checkProjectSurfaces(root: string, sourceRoots: readonly string[] = manifestSourceRoots(root)): SurfaceCheckRun {
  const contracts = expandSourceRoots(root, sourceRoots).flatMap((dir) => walkContracts(root, join(root, dir))).sort();
  if (contracts.length === 0) {
    return {
      code: 2,
      violations: [],
      lines: [`surface-check: no ${sourceRoots.map((r) => `${r}/**/*${CONTRACT_SUFFIX}`).join(", ")} found — a gate that matches nothing is a broken gate`],
    };
  }
  const lines: string[] = [];
  const violations: SurfaceViolation[] = [];
  let misuse = false;
  let pairs = 0;
  for (const rel of contracts) {
    const source = readFileSync(join(root, rel), "utf8");
    const implRel = implementationOf(source, rel);
    if (implRel === undefined) continue;
    if (!existsSync(join(root, implRel))) {
      misuse = true;
      lines.push(`surface-check: ERROR — ${rel} has no implementation ${implRel}; the design gate writes its skeleton`);
      continue;
    }
    pairs += 1;
    const found = compareSurfaces(source, rel, readFileSync(join(root, implRel), "utf8"), implRel);
    violations.push(...found);
    lines.push(...found.map((f) => `surface-check: FAIL ${f.file} — ${f.message}`));
  }
  if (misuse) return { code: 2, violations, lines };
  const counted = `${pairs} contract pair${pairs === 1 ? "" : "s"}`;
  if (violations.length > 0) {
    return { code: 1, violations, lines: [...lines, `surface-check: ${violations.length} violation${violations.length === 1 ? "" : "s"} across ${counted}`] };
  }
  return { code: 0, violations, lines: [`surface-check: OK (${counted})`] };
}

// --- CLI ------------------------------------------------------------------------

function main(argv: string[]): number {
  const [root, ...roots] = argv;
  const project = root ?? process.cwd();
  const result = checkProjectSurfaces(project, roots.length > 0 ? roots : manifestSourceRoots(project));
  for (const line of result.lines) (result.code === 2 ? console.error : console.log)(line);
  return result.code;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exit(main(process.argv.slice(2)));
}
