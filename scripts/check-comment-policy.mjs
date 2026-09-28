#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectCommentBaselines, directiveCounts, COMMENT_ROOTS, PROHIBITED_PATTERNS } from "./comment-policy.mjs";

export const MANIFEST_PATH = "comment-manifest.json";

function byPath(files) {
  return new Map(files.map((file) => [file.path, file]));
}

function add(issues, message) {
  issues.push(message);
}

export async function checkCommentPolicy({ root, manifest } = {}) {
  const currentFiles = await collectCommentBaselines(root);
  const current = byPath(currentFiles);
  const declared = byPath(manifest?.files ?? []);
  const issues = [];
  if (manifest?.version !== 1) add(issues, "comment manifest version must be 1");
  for (const area of COMMENT_ROOTS) {
    const paths = [...declared.keys()].filter((filePath) => filePath === area || filePath.startsWith(`${area}/`));
    for (const filePath of paths) if (!current.has(filePath)) add(issues, `${filePath}: manifest row is stale`);
  }
  for (const [filePath, actual] of current) {
    const baseline = declared.get(filePath);
    if (!baseline) {
      add(issues, `${filePath}: missing comment manifest baseline`);
      continue;
    }
    if (actual.comment_lines > baseline.comment_lines) {
      add(issues, `${filePath}: comment baseline grew from ${baseline.comment_lines} to ${actual.comment_lines}`);
    }
    for (const name of Object.keys(PROHIBITED_PATTERNS)) {
      const before = baseline.prohibited?.[name] ?? 0;
      const after = actual.prohibited?.[name] ?? 0;
      if (after > before) add(issues, `${filePath}: prohibited ${name} pattern grew from ${before} to ${after}`);
    }
  }
  const baselineDirectives = manifest?.directive_counts ?? {};
  const actualDirectives = directiveCounts(currentFiles);
  for (const area of COMMENT_ROOTS) {
    const before = baselineDirectives[area] ?? 0;
    if (actualDirectives[area] < before) add(issues, `${area}: protected lint directive count fell from ${before} to ${actualDirectives[area]}`);
  }
  return { issues, files: currentFiles, directive_counts: actualDirectives };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST_PATH), "utf8"));
  const result = await checkCommentPolicy({ root, manifest });
  if (result.issues.length) {
    for (const issue of result.issues) console.error(issue);
    process.exitCode = 1;
    return;
  }
  console.log(`comment policy check: ${result.files.length} files clean; directives ${JSON.stringify(result.directive_counts)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
