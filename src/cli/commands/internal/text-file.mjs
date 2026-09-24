// text-file.mjs: resolve `--<field>-file` flags to their file contents.
//
// Long free-text fields (body today) may live in a markdown file instead of
// argv so agents cite a temp path without exhausting their context window.
// The adapter resolves the file BEFORE validation, so providers and the
// kernel only ever see the final string. Follows the `batch --file`
// precedent: loud errors, mutual exclusion, no silent truncation.
import { readFile } from "node:fs/promises";
import { throwV2 } from "../../../contracts/errors.mjs";

const MAX_BODY_BYTES = 512 * 1024;

/**
 * Resolve one `--<field>` / `--<field>-file` pair.
 * Returns the inline value, the file content, or undefined when neither
 * was given (so required-field checks keep working downstream).
 */
export async function resolveTextField(command, flags, field) {
  const fileFlag = `${field}-file`;
  const inline = flags[field];
  const file = flags[fileFlag];
  if (inline !== undefined && file !== undefined) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${command}: --${field} and --${fileFlag} are mutually exclusive`,
      { field, command },
    );
  }
  if (file === undefined) return inline;
  if (typeof file !== "string" || !file.trim() || file === true) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${command}: --${fileFlag} requires a file path`,
      { field: fileFlag, command },
    );
  }
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch (err) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${command}: cannot read --${fileFlag} '${file}': ${err.message}`,
      { field: fileFlag, command },
    );
  }
  if (Buffer.byteLength(content, "utf8") > MAX_BODY_BYTES) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${command}: --${fileFlag} '${file}' exceeds ${MAX_BODY_BYTES} bytes`,
      { field: fileFlag, command },
    );
  }
  return content;
}

/**
 * Return a copy of flags with `--body-file` resolved into `body`.
 * Adapters call this before requireFields/buildChanges so the rest of
 * the pipeline is unchanged.
 */
export async function withBodyFile(command, flags) {
  const body = await resolveTextField(command, flags, "body");
  if (body === undefined && flags["body-file"] === undefined) return flags;
  const next = { ...flags, body };
  delete next["body-file"];
  return next;
}
