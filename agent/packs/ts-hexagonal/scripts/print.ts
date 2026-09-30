// The one fixed layout every emitter prints with (TN-26-012 §6): two-space
// indent, double quotes, semicolons, trailing commas in multi-line lists, and
// a line width of 120. It reproduces what the formatter does to the worked
// example's files, so generated files match the example byte for byte.

import type { FeatureContractModel, TypeRef } from "../../ts/scripts/feature-model.ts";

export const WIDTH = 120;

/**
 * `<head> { a, b } <tail>` on one line when it fits in the width, otherwise
 * one name per line with a trailing comma. `head` is e.g. `export type`,
 * `tail` e.g. `from "./x.ts";`.
 */
export function braced(head: string, names: readonly string[], tail: string, indent = ""): string {
  const single = `${indent}${head} { ${names.join(", ")} } ${tail}`;
  if (single.length <= WIDTH) return single;
  return [`${indent}${head} {`, ...names.map((n) => `${indent}  ${n},`), `${indent}} ${tail}`].join("\n");
}

/** A file's text: lines joined, exactly one final newline. */
export function fileText(lines: readonly string[]): string {
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Names declared by the feature's own contract. */
export function localNames(feature: FeatureContractModel): Set<string> {
  const names = [feature.inPort.name, ...feature.outPorts.map((p) => p.name)];
  if (feature.input !== undefined) {
    names.push(feature.input.inputName, feature.input.commandName, feature.input.commandFactoryName);
  }
  return new Set(names);
}

/**
 * The names a set of printed types refer to, split by where they come from:
 * the domain barrel (concepts, and `Result`) or the application layer (the
 * feature's own contract, and the context's shared ports).
 * Both lists are sorted.
 */
export function referencedNames(
  feature: FeatureContractModel,
  types: readonly TypeRef[],
  shared: ReadonlySet<string> = new Set(),
): { readonly domain: string[]; readonly local: string[] } {
  const locals = new Set([...localNames(feature), ...shared]);
  const concepts = new Set(feature.domainTypes);
  const domain = new Set<string>();
  const local = new Set<string>();
  for (const type of types) {
    const bare = type.text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
    for (const [name] of bare.matchAll(IDENTIFIER)) {
      if (locals.has(name)) local.add(name);
      else if (concepts.has(name) || name === "Result") domain.add(name);
    }
  }
  return { domain: [...domain].sort(), local: [...local].sort() };
}

/** `(a: A, b: B): R` for a method signature. */
export function signature(parameters: readonly { name: string; type: TypeRef }[], returns: TypeRef): string {
  return `(${parameters.map((p) => `${p.name}: ${p.type.text}`).join(", ")}): ${returns.text}`;
}

/** `../` repeated to climb from a file's directory to the context source root. */
export function upTo(root: string, filePath: string): string {
  const depth = filePath.slice(root.length + 1).split("/").length - 1;
  return "../".repeat(depth);
}

/** A constructor of parameter properties: one line for one, else one per line. */
export function parameterProperties(prefix: string, params: readonly string[], indent: string): string[] {
  if (params.length === 0) return [];
  if (params.length === 1) return [`${indent}${prefix}(${params[0]}) {}`];
  return [`${indent}${prefix}(`, ...params.map((p) => `${indent}  ${p},`), `${indent}) {}`];
}
