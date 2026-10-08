import { ProtectedPath } from "bounded/path-gate";
import { valueObjectLaws } from "../../domain/shared/value-object.laws.test-support.ts";

const rule = { match: "packages/db/**", deny: ["modify", "delete"], redirect: "Change the schema instead" };
valueObjectLaws("ProtectedPath", ProtectedPath, [rule, { ...rule, match: ".env", deny: ["read"], file: true, why: "secrets" }], [{ ...rule, deny: ["write"] }, { ...rule, match: "/etc/**" }, { ...rule, redirect: " " }]);
