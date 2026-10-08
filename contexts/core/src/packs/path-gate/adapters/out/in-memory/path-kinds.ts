import type { ProjectPath } from "bounded/domain";
import type { PathKind, PathKinds } from "../../../application/judge-calls/judge-calls.contract.ts";

/** What is at each path, as given: undefined where it is given as unknown, else a directory for the root, else nothing. */
export class InMemoryPathKinds implements PathKinds {
  constructor(private readonly kinds: Readonly<Record<string, PathKind | "unknown">>) {}

  kindOf({ value: path }: ProjectPath): PathKind | undefined {
    const given = Object.hasOwn(this.kinds, path) ? this.kinds[path] : undefined;
    if (given === "unknown") return undefined;
    return given ?? (path === "." ? "directory" : "absent");
  }
}
