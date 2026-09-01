// `batch` CLI adapter for the canonical atomic core.batch operation.
//
// The adapter owns only input transport and JSON/document validation. The
// application operation selects the built-in registry and the kernel owns the
// single lock, draft, revision, log and persistence boundary.
import path from "node:path";
import { readFile } from "node:fs/promises";

import { executeBatch, createBuiltinOperationRegistry } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";

export const knownFlags = ["file", "stdin", "as"];

function invalidInput(message, details = {}) {
  throwV2("INVALID_EXECUTION_CONTRACT", `batch: ${message}`, details);
}

async function readStdin() {
  let contents = "";
  for await (const chunk of process.stdin) contents += chunk.toString();
  return contents;
}

async function readInput(flags) {
  const hasFile = flags.file !== undefined;
  const hasStdin = flags.stdin !== undefined;
  if (hasFile && hasStdin) {
    invalidInput("exactly one of --file or --stdin is required", { field: "file,stdin" });
  }
  if (!hasFile && !hasStdin) {
    throwV2("MISSING_FIELD", "batch: exactly one of --file or --stdin is required", { field: "file,stdin" });
  }

  if (hasFile) {
    if (typeof flags.file !== "string" || !flags.file.trim()) {
      invalidInput("--file requires a JSON file path", { field: "file" });
    }
    const file = path.resolve(flags.file);
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      invalidInput(`cannot read input file '${file}'`, {
        field: "file",
        path: file,
        cause: error && error.code ? error.code : "READ_FAILED",
      });
    }
  }

  if (flags.stdin !== true) {
    invalidInput("--stdin does not accept a value", { field: "stdin" });
  }
  return readStdin();
}

function parseDocument(raw) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    invalidInput(`input must be valid JSON (${error.message})`, {
      field: "input",
      cause: "JSON_PARSE_ERROR",
    });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    invalidInput("input document must be an object", { field: "input" });
  }
  for (const key of Object.keys(document)) {
    if (key !== "if_state_revision" && key !== "operations") {
      invalidInput(`unknown input field '${key}'`, { field: key });
    }
  }
  if (!Array.isArray(document.operations) || document.operations.length === 0) {
    invalidInput("input document must contain a non-empty operations array", { field: "operations" });
  }
  return document;
}

export default async function batch({ statePath, projectDir, flags = {}, positional = [] }) {
  if (positional.length > 0) {
    invalidInput("positional arguments are not allowed", { field: "positional" });
  }
  const document = parseDocument(await readInput(flags));
  const actor = resolveAgent(flags, "batch");
  const dir = projectDir || statePath;

  return executeBatch({
    projectDir: dir,
    actor,
    input: document,
    source: {
      registry: createBuiltinOperationRegistry(),
      mutate,
      loadApplicablePolicy,
      authorizeAction,
    },
  });
}
