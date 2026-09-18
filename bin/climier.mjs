#!/usr/bin/env bun
// Executable wrapper for the CLI adapter. Parsing, dispatch, output, and
// process-level error handling live in src/cli/dispatch.mjs.
import { runCli } from "../src/cli/dispatch.mjs";

await runCli();
