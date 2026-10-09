import { describe, expect, test } from "bun:test";
import { loadFailure } from "./load-failure.ts";

describe("loadFailure: why a project's configuration file could not be loaded", () => {
  test("a TypeScript configuration a Node without type stripping cannot load is refused, saying to upgrade Node or write it as bounded.config.mjs, a module in any project", () => {
    const unknownExtension = Object.assign(new TypeError('Unknown file extension ".ts" for /p/bounded.config.ts'), { code: "ERR_UNKNOWN_FILE_EXTENSION" });
    // Not .js: in a CommonJS project (`npm init -y` writes "type": "commonjs") a .js configuration's import fails.
    expect(loadFailure("bounded.config.ts", unknownExtension)).toBe(
      'bounded.config.ts cannot be loaded by this Node (Unknown file extension ".ts" for /p/bounded.config.ts): Node 22.18 or later loads a TypeScript configuration. Upgrade Node, or write the configuration in JavaScript as bounded.config.mjs',
    );
    expect(loadFailure("bounded.config.ts", unknownExtension)).not.toContain("bounded.config.js");
    const stripping = Object.assign(new Error("Stripping types is currently unsupported for files under node_modules"), { code: "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING" });
    expect(loadFailure("bounded.config.ts", stripping)).toContain("Node 22.18 or later loads a TypeScript configuration");
  });

  test("any other failure says what was thrown, as before", () => {
    expect(loadFailure("bounded.config.ts", new Error("half written"))).toBe("bounded.config.ts could not be loaded: half written");
    expect(loadFailure("bounded.config.mjs", Object.assign(new TypeError("x"), { code: "ERR_UNKNOWN_FILE_EXTENSION" }))).toBe("bounded.config.mjs could not be loaded: x");
    expect(loadFailure("bounded.config.js", "a string")).toBe("bounded.config.js could not be loaded: a string");
  });
});
