// The composition root's seam. Until the core integration lands (packs
// contributing guards, bounded.config.ts selecting them, dispatch over the
// composition), there is nothing to compose, so loading refuses: with the
// extension failing closed, every tool call is blocked with this message.
import type { Decide } from "./extension.ts";

/** Composes the project at `root` into its decide. Throws when it cannot. */
export function composeProject(root: string): Decide {
  throw new Error(`bounded-pi cannot compose ${root} yet: reading bounded.config.ts arrives with the core integration`);
}
