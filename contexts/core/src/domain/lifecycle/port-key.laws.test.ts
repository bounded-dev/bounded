import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { PortKey } from "./port-key.ts";

valueObjectLaws("PortKey", PortKey, ["acme/rules#sourceFiles", "test-packs/gate#files"], ["files", "acme/rules#Files"]);
