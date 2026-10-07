// The entry point with a refusing decide injected, as the end-to-end test
// runs it: what a composed bounded.config.ts will later supply.
import { Verdict } from "bounded/domain";
import { main } from "../../src/main.ts";

await main((event) => Verdict.refuse(`Refused ${event.tool}: ${JSON.stringify(event.effects)}`, "Ask the project's maintainer"));
