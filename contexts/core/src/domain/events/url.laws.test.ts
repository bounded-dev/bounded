import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Url } from "./url.ts";

valueObjectLaws("Url", Url, ["https://example.com/a", "mailto:someone@example.com"], ["example.com", "https://a b", "", "https://a\u0007"]);
textValueLaws("Url", Url, [["https://example.com/a", "https://example.com/a"]]);
