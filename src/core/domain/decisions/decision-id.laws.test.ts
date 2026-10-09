import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { DecisionId } from "./decision-id.ts";

valueObjectLaws("DecisionId", DecisionId, ["0b8e3f1a-2c4d-4e5f-9a6b-7c8d9e0f1a2b", "d-1"], ["", " ", "a\nb", "x".repeat(257)]);
textValueLaws("DecisionId", DecisionId, [["d-1", "d-1"]]);
