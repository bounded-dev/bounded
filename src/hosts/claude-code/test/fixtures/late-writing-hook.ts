// A decide that answers, then writes one more line after the answer is out,
// as the core's Bounded log may when a late record settles.
import { Verdict } from "bounded/domain";
import { run } from "../../run.ts";

await run(() => {
  setTimeout(() => process.stderr.write("late log line\n"), 100);
  return Verdict.refuse("No", "Ask");
});
