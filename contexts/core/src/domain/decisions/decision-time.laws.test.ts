import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { DecisionTime } from "./decision-time.ts";

valueObjectLaws("DecisionTime", DecisionTime, ["2026-10-07T12:00:00.000Z", "1999-12-31T23:59:59.999Z"], ["yesterday", "2026-10-07"]);
textValueLaws("DecisionTime", DecisionTime, [["2026-10-07T12:00:00.000Z", "2026-10-07T12:00:00.000Z"]]);
