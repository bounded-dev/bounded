// A project's bounded.config.ts is an ES module (`export default
// defineConfig(...)`), whatever its package.json's "type" says. Node decides a
// .ts file's format from that field, and `npm init -y` writes
// "type": "commonjs", so node would read the configuration as CommonJS and
// refuse its `import`. Under node, a load hook makes node load the
// configuration as TypeScript ESM; bun reads it as a module by itself, and
// offers no such hook, so nothing is registered there.
import * as nodeModule from "node:module";

type LoadContext = { readonly format?: string | null | undefined } & Record<string, unknown>;
type NextLoad = (url: string, context: LoadContext) => unknown;
type RegisterHooks = (hooks: { load(url: string, context: LoadContext, nextLoad: NextLoad): unknown }) => unknown;

/** A bounded.config.ts module URL, with or without the query a reload adds. */
const CONFIG_TS = /\/bounded\.config\.ts(\?.*)?$/;

let registered = false;

/** Makes node load every bounded.config.ts as TypeScript ESM, once per process; does nothing where the runtime has no load hooks. */
export function loadConfigAsModule(): void {
  if (registered) return;
  registered = true;
  const registerHooks: unknown = Reflect.get(nodeModule, "registerHooks");
  if (typeof registerHooks !== "function") return;
  const register: RegisterHooks = (hooks) => Reflect.apply(registerHooks, nodeModule, [hooks]);
  register({
    load: (url, context, nextLoad) => nextLoad(url, CONFIG_TS.test(url) ? { ...context, format: "module-typescript" } : context),
  });
}
