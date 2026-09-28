#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectCommentBaselines, directiveCounts } from "./comment-policy.mjs";
import { MANIFEST_PATH } from "./check-comment-policy.mjs";

function assertRatchet(file, old) {
  if (file.comment_lines > old.comment_lines) {
    throw new Error(`${file.path}: comment baseline grew from ${old.comment_lines} to ${file.comment_lines}; remove comments before regenerating`);
  }
  for (const [name, count] of Object.entries(file.prohibited)) {
    if (count > (old.prohibited?.[name] ?? 0)) {
      throw new Error(`${file.path}: prohibited ${name} baseline grew; remove the pattern before regenerating`);
    }
  }
}

function assertBaselines(files, previous) {
  const oldFiles = new Map((previous.files ?? []).map((file) => [file.path, file]));
  for (const file of files) {
    const old = oldFiles.get(file.path);
    if (old) {assertRatchet(file, old);}
  }
}

export async function generateCommentManifest({ root, previous = { version: 1, files: [] } } = {}) {
  const files = await collectCommentBaselines(root);
  assertBaselines(files, previous);
  return { version: 1, files, directive_counts: directiveCounts(files) };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = path.join(root, MANIFEST_PATH);
  const previous = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "{\"version\":1,\"files\":[]}"));
  const manifest = await generateCommentManifest({ root, previous });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`comment manifest: ${manifest.files.length} files; directives ${JSON.stringify(manifest.directive_counts)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {await main();}
