// A decide that never settles and leaves work running forever, with a short
// deadline and drain injected so the test stays quick.
import { run } from "../../src/run.ts";

await run(
  () => {
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  },
  { deadlineMs: 200, drainMs: 300 },
);
