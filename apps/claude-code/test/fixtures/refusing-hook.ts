// The hook with a refusing decide injected, as the end-to-end test runs it:
// what a composed bounded.config.ts will later supply.
import { Verdict } from "bounded/domain";
import { run } from "../../src/run.ts";

await run((event) => Verdict.refuse(`Refused ${event.tool}: ${JSON.stringify(event.effects)}`, "Ask the project's maintainer"));
