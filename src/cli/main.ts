#!/usr/bin/env bun
// The `bounded` bin: runs the CLI in the current directory, the project's root.
import { runBoundedCli } from "./bounded-cli.ts";

const ran = await runBoundedCli(process.argv.slice(2), process.cwd());
process.stdout.write(ran.stdout);
process.stderr.write(ran.stderr);
process.exitCode = ran.exitCode;
