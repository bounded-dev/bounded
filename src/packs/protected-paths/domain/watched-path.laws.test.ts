import { valueObjectLaws } from "../../../core/domain/shared/value-object.laws.test-support.ts";
import { WatchedPath } from "./watched-path.ts";

const rule = { match: "generated/**", why: "generated/ is written by the generator", redirect: "Change the generator's input instead" };
valueObjectLaws("WatchedPath", WatchedPath, [rule, { ...rule, match: "build/**", except: ["build/keep.txt"] }], [{ ...rule, match: "/etc/**" }, { ...rule, why: " " }, { ...rule, except: "x" }]);
