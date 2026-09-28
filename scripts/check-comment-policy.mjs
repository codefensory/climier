#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectCommentBaselines, directiveCounts, COMMENT_ROOTS, PROHIBITED_PATTERNS } from "./comment-policy.mjs";

export const MANIFEST_PATH = "comment-manifest.json";

function byPath(files) {
  return new Map(files.map((file) => [file.path, file]));
}

function staleRows(declared, current) {
  return [...declared.keys()]
    .filter((filePath) => COMMENT_ROOTS.some((area) => filePath === area || filePath.startsWith(`${area}/`)))
    .filter((filePath) => !current.has(filePath))
    .map((filePath) => `${filePath}: manifest row is stale`);
}

function fileIssues(actual, baseline) {
  const issues = [];
  if (actual.comment_lines > baseline.comment_lines) {
    issues.push(`${actual.path}: comment baseline grew from ${baseline.comment_lines} to ${actual.comment_lines}`);
  }
  for (const name of Object.keys(PROHIBITED_PATTERNS)) {
    const before = baseline.prohibited?.[name] ?? 0;
    const after = actual.prohibited?.[name] ?? 0;
    if (after > before) {issues.push(`${actual.path}: prohibited ${name} pattern grew from ${before} to ${after}`);}
  }
  return issues;
}

function currentFileIssues(currentFiles, declared) {
  const issues = [];
  for (const actual of currentFiles) {
    const baseline = declared.get(actual.path);
    if (!baseline) {issues.push(`${actual.path}: missing comment manifest baseline`); continue;}
    issues.push(...fileIssues(actual, baseline));
  }
  return issues;
}

function directiveIssues(manifest, currentFiles) {
  const actual = directiveCounts(currentFiles);
  const issues = [];
  for (const area of COMMENT_ROOTS) {
    const before = manifest?.directive_counts?.[area] ?? 0;
    if (actual[area] < before) {issues.push(`${area}: protected lint directive count fell from ${before} to ${actual[area]}`);}
  }
  return { actual, issues };
}

export async function checkCommentPolicy({ root, manifest } = {}) {
  const currentFiles = await collectCommentBaselines(root);
  const current = byPath(currentFiles);
  const declared = byPath(manifest?.files ?? []);
  const directives = directiveIssues(manifest, currentFiles);
  const issues = [
    ...(manifest?.version === 1 ? [] : ["comment manifest version must be 1"]),
    ...staleRows(declared, current),
    ...currentFileIssues(currentFiles, declared),
    ...directives.issues,
  ];
  return { issues, files: currentFiles, directive_counts: directives.actual };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST_PATH), "utf8"));
  const result = await checkCommentPolicy({ root, manifest });
  if (result.issues.length) {
    for (const issue of result.issues) {console.error(issue);}
    process.exitCode = 1;
    return;
  }
  console.log(`comment policy check: ${result.files.length} files clean; directives ${JSON.stringify(result.directive_counts)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {await main();}
