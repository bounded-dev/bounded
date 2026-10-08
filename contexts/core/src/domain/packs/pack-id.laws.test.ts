import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { PackId } from "./pack-id.ts";

valueObjectLaws("PackId", PackId, ["bounded/core", "@acme/rules/web-2"], ["core", "bounded/", "Bounded/core", "bounded/a--b"]);
textValueLaws("PackId", PackId, [["bounded/path-gate", "bounded/path-gate"], ["my.pkg/a", "my.pkg/a"]]);
