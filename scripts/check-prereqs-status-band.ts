// check-prereqs-status-band — the prereqs status band's own check (ADR 2026-027).
//
//   bun run check:prereqs-status-band
//
// The band is a Claude Code plugin folder (src/hosts/claude-code/prereqs-status-band),
// so it is checked by Claude Code itself, outside `bun run check`, on a fresh
// temporary copy of the folder (so nothing is written into the source tree):
//
//   1. `claude plugin validate <copy>`: fails on a non-zero exit or on any
//      hook it lists as a gating hook without .catch;
//   2. `claude plugin test <copy>`: the plugin tests in tests/*.test.ts;
//   3. `tsc -p <copy>` against the declarations Claude Code lays beside a
//      plugin it loads (.claude-plugin/types/ and the tsconfig.json that
//      extends them). Neither step above lays them; an interactive load does,
//      so they are taken from the source folder, laid there by
//      `claude --plugin-dir src/hosts/claude-code/prereqs-status-band`. Their
//      first line names the Claude Code build that wrote them, which must be
//      the one on PATH: the band is never type-checked against another
//      build's declarations.
//
// Exit status: 0 every step passed, 1 a step failed, 2 Claude Code is not on PATH.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BAND = join(ROOT, "src", "hosts", "claude-code", "prereqs-status-band");
/** What Claude Code writes into a plugin folder it loads: never part of the band's source. */
const ENGINE_WRITTEN = [join(".claude-plugin", "types"), "tsconfig.json"];
const DECLARATIONS = join(".claude-plugin", "types", "claude-code", "index.d.ts");

const claude = Bun.which("claude");
if (claude === null) {
  console.error("Claude Code (claude) is not on PATH: install it to check the prereqs status band");
  process.exit(2);
}

/** Runs `argv`, printing its output whole; resolves its exit code and output. */
function run(title: string, argv: string[]): { exitCode: number; output: string } {
  console.log(`\n== ${title}: ${argv.map((part) => relative(ROOT, part) || part).join(" ")}`);
  const ran = Bun.spawnSync(argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const output = `${ran.stdout.toString()}${ran.stderr.toString()}`;
  process.stdout.write(output);
  return { exitCode: ran.exitCode, output };
}

const engineWritten = (path: string): boolean => {
  const inBand = relative(BAND, path);
  return ENGINE_WRITTEN.some((written) => inBand === written || inBand.startsWith(`${written}${sep}`));
};

const failures: string[] = [];
const copy = mkdtempSync(join(tmpdir(), "prereqs-status-band-check-"));
try {
  cpSync(BAND, copy, { recursive: true, filter: (path) => !engineWritten(path) });

  const validated = run("validate", [claude, "plugin", "validate", copy]);
  if (validated.exitCode !== 0) failures.push(`claude plugin validate exited ${validated.exitCode}`);
  const ungated = validated.output.split("\n").filter((line) => line.includes("gating hook without .catch:"));
  if (ungated.length > 0) failures.push(`claude plugin validate lists a gating hook without .catch: ${ungated.map((line) => line.trim()).join("; ")}`);

  const tested = run("plugin tests", [claude, "plugin", "test", copy]);
  if (tested.exitCode !== 0) failures.push(`claude plugin test exited ${tested.exitCode}`);

  if (!existsSync(join(copy, DECLARATIONS))) {
    if (existsSync(join(BAND, DECLARATIONS)) && existsSync(join(BAND, "tsconfig.json"))) {
      for (const written of ENGINE_WRITTEN) cpSync(join(BAND, written), join(copy, written), { recursive: true });
    }
  }
  if (!existsSync(join(copy, DECLARATIONS))) {
    failures.push(`Claude Code's declarations are not laid: load the band once with \`claude --plugin-dir ${relative(ROOT, BAND)}\` (an interactive session), which writes them into its folder`);
  } else {
    const writtenBy = /^\/\/ Written by Claude Code (\S+?)\.?$/m.exec(readFileSync(join(copy, DECLARATIONS), "utf8").split("\n")[0] ?? "")?.[1];
    const installed = /^(\S+)/.exec(Bun.spawnSync([claude, "--version"], { stdout: "pipe" }).stdout.toString().trim())?.[1];
    if (writtenBy === undefined || installed === undefined || writtenBy !== installed) {
      failures.push(`the declarations were written by Claude Code ${writtenBy ?? "(unknown)"}, but ${installed ?? "(unknown)"} is installed: load the band once with \`claude --plugin-dir ${relative(ROOT, BAND)}\` so they are rewritten`);
    } else {
      console.log(`\n(declarations written by Claude Code ${writtenBy}, the installed build)`);
      const typed = run("tsc", [join(ROOT, "node_modules", ".bin", "tsc"), "-p", copy]);
      if (typed.exitCode !== 0) failures.push(`tsc over the band against Claude Code's declarations exited ${typed.exitCode}`);
    }
  }
} finally {
  rmSync(copy, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nThe prereqs status band's check failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("\nThe prereqs status band's check passed: validate, plugin tests and tsc.");
