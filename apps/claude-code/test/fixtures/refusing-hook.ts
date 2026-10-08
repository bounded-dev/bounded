// The hook with a refusing decide injected in place of the project's
// configuration, as the end-to-end test runs it.
import { Verdict } from "bounded/domain";
import { run } from "../../src/run.ts";

await run((event) => Verdict.refuse(`Refused ${event.toolKind}: ${JSON.stringify(event.effects)}`, "Ask the project's maintainer"));
