import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { serviceRuntimeSupport, serviceRuntimeTargets } from "./service-runtime-support.ts";

describe("service runtime support file", () => {
  test("serviceRuntimeTargets resolves the specifier relative to the contract", () => {
    expect(
      serviceRuntimeTargets(
        'import type { Ack } from "./service-runtime.js";\nimport type { X } from "../other/service-runtime.js";\n',
        "/repo/src/api/api.contract.ts",
      ),
    ).toEqual(["/repo/src/api/service-runtime.ts", "/repo/src/other/service-runtime.ts"]);
    expect(serviceRuntimeTargets('import type { Y } from "./values.js";\n', "/r/c.contract.ts")).toEqual([]);
  });

  test("ships this pack's canonical runtime", () => {
    expect(serviceRuntimeSupport.canonical).toBe("packs/ts-trpc/api/service-runtime.ts");
    expect(serviceRuntimeSupport.source())
      .toBe(readFileSync(join(import.meta.dirname, "api/service-runtime.ts"), "utf8"));
  });
});
