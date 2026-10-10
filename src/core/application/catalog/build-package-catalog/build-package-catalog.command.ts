import type { buildPackageCatalogCommandBrand } from "./build-package-catalog.contract.ts";
import type { Result } from "bounded/domain";
import type * as Contract from "./build-package-catalog.contract.ts";

const INVALID = "A package's directory is an absolute directory path, such as /home/me/my-pack";
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;

class BuildPackageCatalogCommandImpl implements Contract.BuildPackageCatalogCommand {
  declare readonly __brand: "BuildPackageCatalogCommand";
  declare readonly [buildPackageCatalogCommandBrand]: true;
  private constructor(readonly packageDir: string) {
    Object.freeze(this);
  }

  static parse(raw: unknown): Result<BuildPackageCatalogCommand> {
    const packageDir = typeof raw === "object" && raw !== null && Object.hasOwn(raw, "packageDir") && "packageDir" in raw ? raw.packageDir : undefined;
    if (typeof packageDir !== "string" || !ABSOLUTE.test(packageDir)) return { ok: false, error: INVALID };
    return { ok: true, value: new BuildPackageCatalogCommandImpl(packageDir) };
  }
}

export type BuildPackageCatalogCommand = Contract.BuildPackageCatalogCommand;
export const BuildPackageCatalogCommand: Contract.BuildPackageCatalogCommandFactory = BuildPackageCatalogCommandImpl;
