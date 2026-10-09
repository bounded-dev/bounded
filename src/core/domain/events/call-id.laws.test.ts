import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { CallId } from "./call-id.ts";

valueObjectLaws("CallId", CallId, ["toolu_1", "call/1:x"], ["", " ", "a\nb", "x".repeat(257)]);
textValueLaws("CallId", CallId, [["toolu_1", "toolu_1"], ["x".repeat(256), "x".repeat(256)]]);
