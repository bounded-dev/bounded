// Why a project's configuration file could not be loaded, as the refusal says it.
// Node loads a TypeScript configuration by stripping its types, from 22.18
// on (earlier, with a flag); one that cannot strips nothing and refuses the
// file. That refusal says what to do: upgrade Node, or write the
// configuration in JavaScript, as .mjs: a .js file is CommonJS in a project whose package.json says so, as `npm init -y` writes.

/** The error codes Node gives when it will not strip a TypeScript file's types. */
const CANNOT_STRIP_TYPES = new Set(["ERR_UNKNOWN_FILE_EXTENSION", "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING", "ERR_NO_TYPESCRIPT"]);

function described(thrown: unknown): string {
  try {
    return thrown instanceof Error ? thrown.message : String(thrown);
  } catch {
    return "a value that cannot be printed";
  }
}

const codeOf = (thrown: unknown): unknown => (thrown instanceof Error && "code" in thrown ? thrown.code : undefined);

/** The message for `name` failing to load with `thrown`. */
export function loadFailure(name: string, thrown: unknown): string {
  const code = codeOf(thrown);
  if (name.endsWith(".ts") && typeof code === "string" && CANNOT_STRIP_TYPES.has(code)) {
    return `${name} cannot be loaded by this Node (${described(thrown)}): Node 22.18 or later loads a TypeScript configuration. Upgrade Node, or write the configuration in JavaScript as bounded.config.mjs`;
  }
  return `${name} could not be loaded: ${described(thrown)}`;
}
