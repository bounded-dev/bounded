import { valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { PortKey } from "./port-key.ts";

valueObjectLaws("PortKey", PortKey, ["bounded/path-gate#watchedFiles", "test-packs/gate#files"], ["files", "bounded/path-gate#Files"]);
