import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// A file is in the raw lane when it calls one of the pre-cut writers directly.
// Covers `writeState` and `updateState`, plus the local `bootstrapState`
// wrappers several suites define around them.
const RAW_WRITER_CALL = /(?:^|[^.\w])(?:writeState|updateState|bootstrapState)\s*\(/m;

export async function findRawWriterFiles(directory, relativeTo = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findRawWriterFiles(entryPath, relativeTo));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".test.mjs") || entry.name.startsWith("ui-")) continue;
    const source = await readFile(entryPath, "utf8");
    if (RAW_WRITER_CALL.test(source)) {
      files.push(path.relative(relativeTo, entryPath).split(path.sep).join("/"));
    }
  }
  return files.toSorted();
}
