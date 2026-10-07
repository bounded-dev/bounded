// The path gate (slice 3): an ordinary pack shipped in the `bounded` package.
// It depends only on the core's public exports; the core never imports it.
export { pathGate } from "./path-gate.ts";
export type { PathAccess, ProtectedPathFactory } from "./protected-path.ts";
export { ProtectedPath, writes } from "./protected-path.ts";
