// The analysis every ts-hexagonal lint rule shares: where a file sits, which
// workspace a package name belongs to, every import form a file uses, and
// which boundary each import crosses. It mirrors the shipped
// `architecture.test.ts` rule for rule (the pack's tests run both over the
// same seeded violations), so the lint and the test never disagree about a
// boundary; the lint only says it sooner, naming the fix.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { type HexLocation, isTestSide, joinRelative, locate, packageOf } from "../scripts/grammar.ts";

export interface HexFile {
  /** Absolute project root. */
  readonly root: string;
  /** Project-relative, `/`-separated. */
  readonly path: string;
  readonly location: HexLocation;
  readonly testSide: boolean;
}

/** Where a linted file sits, or undefined when it is under no source root.
 *  The ESLint cwd is the project root in every gate run; a path outside it is
 *  located by its last `contexts|apps/<name>/src/` segment instead. */
export function hexFile(filename: string, cwd: string): HexFile | undefined {
  const absolute = filename.split(sep).join("/");
  const fromCwd = relative(cwd, filename).split(sep).join("/");
  if (!fromCwd.startsWith("..") && !isAbsolute(fromCwd)) {
    const location = locate(fromCwd);
    if (location !== undefined) return { root: cwd, path: fromCwd, location, testSide: isTestSide(fromCwd) };
  }
  const last = [...absolute.matchAll(/(?:^|\/)(?=(?:contexts|apps)\/[^/]+\/src\/)/g)].at(-1);
  if (last === undefined) return undefined;
  const start = last.index + (absolute[last.index] === "/" ? 1 : 0);
  const path = absolute.slice(start);
  const location = locate(path);
  if (location === undefined) return undefined;
  return { root: absolute.slice(0, start).replace(/\/$/, "") || "/", path, location, testSide: isTestSide(path) };
}

export interface Workspace {
  readonly kind: "context" | "app";
  readonly name: string;
  readonly dir: string;
}

/** Package name → workspace, read from `{contexts,apps}/*\/package.json`
 *  under the project root. A rule option `workspaces` (package → dir)
 *  replaces the read, for fixtures. */
export function workspaceIndex(root: string, override?: Readonly<Record<string, string>>): Map<string, Workspace> {
  const out = new Map<string, Workspace>();
  const add = (pkg: string, dir: string): void => {
    const [top, name] = dir.split("/");
    if ((top === "contexts" || top === "apps") && name !== undefined) out.set(pkg, { kind: top === "contexts" ? "context" : "app", name, dir });
  };
  if (override !== undefined) {
    for (const [pkg, dir] of Object.entries(override)) add(pkg, dir);
    return out;
  }
  for (const top of ["contexts", "apps"]) {
    const parent = join(root, top);
    if (!existsSync(parent)) continue;
    for (const name of readdirSync(parent).sort()) {
      const manifest = join(parent, name, "package.json");
      try {
        if (!statSync(join(parent, name)).isDirectory() || !existsSync(manifest)) continue;
        const pkg = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
        if (typeof pkg === "string") add(pkg, `${top}/${name}`);
      } catch {
        // An unreadable manifest names no package; the architecture test and
        // the config check report it. The lint judges what it can read.
      }
    }
  }
  return out;
}

/** One import-like use of a module. */
export interface Use {
  readonly node: TSESTree.Node;
  /** Undefined for a computed `import(x)` / `require(x)`. */
  readonly spec: string | undefined;
  /** `import type`, `export type`, `import("x").T`: erased at runtime. */
  readonly typeOnly: boolean;
  /** `import { type A }`: every name a type, but the module still loads. */
  readonly inlineTypes: boolean;
  /** Imported (or re-exported) names, as the exporting module calls them. */
  readonly names: readonly string[];
  /** A member read off a namespace import: `App.CreateNoteHandler`. */
  readonly member: boolean;
}

const literal = (node: TSESTree.Node | null | undefined): string | undefined => {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]!.value.cooked ?? undefined;
  return undefined;
};

const importedName = (s: TSESTree.ImportSpecifier | TSESTree.ExportSpecifier, key: "imported" | "local"): string => {
  const id = key === "imported" ? (s as TSESTree.ImportSpecifier).imported : (s as TSESTree.ExportSpecifier).local;
  return id.type === "Identifier" ? id.name : String(id.value);
};

/** Visitors that report every import form to `onUse`. */
export function importVisitors(onUse: (use: Use) => void): TSESLint.RuleListener {
  const namespaces = new Set<string>();
  const use = (node: TSESTree.Node, spec: string | undefined, typeOnly: boolean, names: string[] = [], inlineTypes = false): void =>
    onUse({ node, spec, typeOnly, inlineTypes, names, member: false });
  return {
    ImportDeclaration(node): void {
      const names: string[] = [];
      let named = 0;
      let typed = 0;
      let other = false;
      for (const s of node.specifiers) {
        if (s.type === "ImportSpecifier") {
          names.push(importedName(s, "imported"));
          named++;
          if (s.importKind === "type") typed++;
        } else {
          other = true;
          if (s.type === "ImportDefaultSpecifier") names.push("default");
          if (s.type === "ImportNamespaceSpecifier") namespaces.add(s.local.name);
        }
      }
      use(node, node.source.value, node.importKind === "type", names, !other && named > 0 && typed === named);
    },
    ExportNamedDeclaration(node): void {
      if (node.source === null) return;
      const names = node.specifiers.map((s) => importedName(s, "local"));
      const inline = node.specifiers.length > 0 && node.specifiers.every((s) => s.exportKind === "type");
      use(node, node.source.value, node.exportKind === "type", names, inline);
    },
    ExportAllDeclaration(node): void {
      use(node, node.source.value, node.exportKind === "type");
    },
    TSImportEqualsDeclaration(node): void {
      if (node.moduleReference.type === "TSExternalModuleReference") {
        use(node, literal(node.moduleReference.expression), node.importKind === "type", [node.id.name]);
      }
    },
    ImportExpression(node): void {
      use(node, literal(node.source), false);
    },
    CallExpression(node): void {
      if (node.callee.type === "Identifier" && node.callee.name === "require") use(node, literal(node.arguments[0]), false);
    },
    TSImportType(node): void {
      const argument = (node as unknown as { argument: TSESTree.Node; source?: TSESTree.Node }).source ??
        (node as unknown as { argument: TSESTree.Node }).argument;
      const spec = argument?.type === "TSLiteralType" ? literal(argument.literal) : literal(argument);
      const qualifier = node.qualifier;
      const last = qualifier === null ? undefined : qualifier.type === "Identifier" ? qualifier.name
        : qualifier.type === "TSQualifiedName" ? qualifier.right.name : undefined;
      use(node, spec, true, last === undefined ? [] : [last]);
    },
    MemberExpression(node): void {
      if (node.object.type === "Identifier" && namespaces.has(node.object.name) && node.property.type === "Identifier" && !node.computed) {
        onUse({ node, spec: node.object.name, typeOnly: false, inlineTypes: false, names: [node.property.name], member: true });
      }
    },
    TSQualifiedName(node): void {
      if (node.left.type === "Identifier" && namespaces.has(node.left.name)) {
        onUse({ node, spec: node.left.name, typeOnly: true, inlineTypes: false, names: [node.right.name], member: true });
      }
    },
  };
}

export type BoundaryRule = "layers" | "apps" | "contexts" | "browser" | "in-adapters";

export interface Problem {
  readonly rule: BoundaryRule;
  readonly message: string;
}

const LAYER_ALLOWS: Readonly<Record<string, readonly string[]>> = {
  domain: ["domain"],
  application: ["domain", "application"],
  "adapters-in": ["domain", "application", "adapters-in"],
  "adapters-out": ["domain", "application", "adapters-out"],
};

export const isExportPath = (subpath: string): boolean =>
  subpath === "domain" || subpath === "application" || /^adapters\/[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(subpath);

const INWARDS = "dependencies point inwards: domain <- application <- adapters";

/** Where an import leads, relative to the importing file. */
export type Target =
  | { readonly kind: "file"; readonly path: string; readonly location: HexLocation | undefined }
  | { readonly kind: "outside" }
  | { readonly kind: "workspace"; readonly workspace: Workspace; readonly subpath: string }
  | { readonly kind: "external"; readonly name: string };

export function resolveUse(file: HexFile, spec: string, index: ReadonlyMap<string, Workspace>): Target {
  if (spec.startsWith(".")) {
    const path = joinRelative(file.path.split("/").slice(0, -1).join("/"), spec);
    return path === undefined ? { kind: "outside" } : { kind: "file", path, location: locate(path) };
  }
  if (spec.startsWith("/")) return { kind: "outside" };
  const pkg = packageOf(spec);
  const workspace = pkg === undefined ? undefined : index.get(pkg.name);
  if (workspace !== undefined) return { kind: "workspace", workspace, subpath: pkg!.subpath };
  return { kind: "external", name: pkg?.name ?? spec };
}

/** Every boundary one use crosses. Namespace member reads only matter to the
 *  handler-class rule. */
export function boundaryProblems(file: HexFile, use: Use, index: ReadonlyMap<string, Workspace>): Problem[] {
  const out: Problem[] = [];
  const from = file.location;
  const spec = use.spec;
  if (from.workspace === "context" && from.layer === "adapters-in") {
    const handler = use.names.find((n) => /Handler$/.test(n));
    if (handler !== undefined || (!use.member && spec !== undefined && /\.handler(\.[cm]?[jt]s)?$/.test(spec))) {
      out.push({
        rule: "in-adapters",
        message: `'${handler ?? spec}' is a handler; in adapters depend on in-port interfaces (e.g. CreateNote), never handler classes`,
      });
    }
  }
  if (use.member) return out;
  if (spec === undefined) {
    out.push({ rule: "layers", message: "an import with a computed specifier cannot be checked; import a literal path" });
    return out;
  }
  const target = resolveUse(file, spec, index);
  return [...out, ...(from.workspace === "context" ? contextProblems(file, from, target, spec) : appProblems(from, use, target))];
}

function contextProblems(
  file: HexFile,
  from: Extract<HexLocation, { workspace: "context" }>,
  target: Target,
  spec: string,
): Problem[] {
  const layers = (message: string): Problem[] => [{ rule: "layers", message }];
  if (from.layer === "none") return [];
  if (target.kind === "outside") return layers("it reaches outside the project; import a package or a file inside this context");
  if (target.kind === "file") {
    const to = target.location;
    if (to === undefined) return layers("it reaches outside every source root");
    if (to.dir !== from.dir) {
      return [{ rule: "contexts", message: `it reaches into ${to.dir} by a relative path; contexts never import each other or an app` }];
    }
    if (to.workspace !== "context" || to.layer === "none") return layers("its target sits in no layer");
    if (!LAYER_ALLOWS[from.layer]!.includes(to.layer)) return layers(`${from.layer} may not depend on ${to.layer}; ${INWARDS}`);
    if (from.tech !== undefined && to.tech !== undefined && (from.tech !== to.tech || from.layer !== to.layer)) {
      return layers(`adapters never import other adapters (${from.layer}/${from.tech} -> ${to.layer}/${to.tech})`);
    }
    return [];
  }
  if (target.kind === "workspace") {
    const { workspace, subpath } = target;
    if (workspace.kind === "app") return [{ rule: "contexts", message: `contexts never import an app (${workspace.dir})` }];
    if (workspace.dir !== from.dir) {
      if (from.layer === "adapters-out" && subpath === "application") return [];
      return [{
        rule: "contexts",
        message: `contexts never import each other (${workspace.dir}); only an out adapter may call another context's application`,
      }];
    }
    if (!isExportPath(subpath)) return layers("import a package only through its export paths (domain, application, adapters/<tech>)");
    const toLayer = subpath === "domain" ? "domain" : subpath === "application" ? "application" : "adapters";
    if (from.layer === "domain") {
      return layers(toLayer === "domain" ? "domain files import each other by relative path, never through the package" : `domain may not depend on ${toLayer}; ${INWARDS}`);
    }
    if (from.layer === "application" && toLayer !== "domain") {
      return layers(toLayer === "application" ? "application files import their own feature's files by relative path" : `application may not depend on adapters; ${INWARDS}`);
    }
    if (toLayer === "adapters") return layers("adapters never import other adapters");
    return [];
  }
  if ((from.layer === "domain" || from.layer === "application") && !file.testSide && spec !== "zod" && !spec.startsWith("zod/")) {
    return layers(`${from.layer} code may use no library but zod: it holds no I/O and no framework`);
  }
  return [];
}

function appProblems(from: Extract<HexLocation, { workspace: "app" }>, use: Use, target: Target): Problem[] {
  const out: Problem[] = [];
  let server = false;
  if (target.kind === "outside") {
    out.push({ rule: "apps", message: "it reaches outside the project" });
  } else if (target.kind === "file") {
    const to = target.location;
    if (to === undefined || to.dir !== from.dir) {
      out.push({ rule: "apps", message: "an app reaches only its own src/ by relative path; other workspaces through their packages" });
    } else if (from.browser && to.inner[0] !== from.inner[0]) {
      server = true;
    }
  } else if (target.kind === "workspace") {
    if (target.workspace.kind === "app") out.push({ rule: "apps", message: `apps never import other apps (${target.workspace.dir})` });
    else {
      server = true;
      if (!isExportPath(target.subpath)) {
        out.push({ rule: "apps", message: "import a context only through its export paths (domain, application, adapters/<tech>)" });
      }
    }
  }
  if (from.browser && server && !use.typeOnly) {
    out.push({
      rule: "browser",
      message: use.inlineTypes
        ? "'import { type … }' still loads the module in the browser; write 'import type { … }'"
        : "browser code imports server code as types only: write 'import type { … }'",
    });
  }
  return out;
}

export interface HexRuleOptions {
  /** Package name → workspace dir. Replaces reading the manifests (fixtures). */
  readonly workspaces?: Readonly<Record<string, string>>;
}

export const OPTIONS_SCHEMA = [{
  type: "object" as const,
  properties: { workspaces: { type: "object" as const, additionalProperties: { type: "string" as const } } },
  additionalProperties: false,
}];

/** A rule that reports one family of boundary problems. */
export function boundaryListener(
  context: Readonly<TSESLint.RuleContext<string, readonly (HexRuleOptions | undefined)[]>>,
  rules: readonly BoundaryRule[],
  report: (node: TSESTree.Node, message: string) => void,
): TSESLint.RuleListener {
  const file = hexFile(context.filename, context.cwd);
  if (file === undefined) return {};
  const index = workspaceIndex(file.root, context.options[0]?.workspaces);
  return importVisitors((use) => {
    for (const problem of boundaryProblems(file, use, index)) {
      if (rules.includes(problem.rule)) {
        report(use.node, `'${use.spec ?? "(computed)"}': ${problem.message}`);
      }
    }
  });
}
