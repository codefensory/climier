#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind, ts } from "ts-morph";

const ROOT = process.cwd();
const BASELINE_FILE = path.join(ROOT, ".types-budget.json");
const SOURCE_GLOBS = ["src/**/*.ts", "bin/**/*.ts", "scripts/**/*.ts"];
const METRICS = ["any", "as_any", "ts_expect_error"] as const;
type Metric = (typeof METRICS)[number];
type Budget = Record<Metric, number>;

function countDirectiveComments(text: string): number {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  let count = 0;
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      count += (scanner.getTokenText().match(/@ts-expect-error\b/g) ?? []).length;
    }
    token = scanner.scan();
  }
  return count;
}

function countBudget(): Budget {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  const sourceFiles = project.addSourceFilesAtPaths(
    SOURCE_GLOBS.map((pattern) => path.join(ROOT, pattern)),
  );
  const current: Budget = { any: 0, as_any: 0, ts_expect_error: 0 };

  for (const sourceFile of sourceFiles) {
    current.any += sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword).length;
    current.as_any += sourceFile
      .getDescendantsOfKind(SyntaxKind.AsExpression)
      .filter((expression) => expression.getTypeNode()?.getText().trim() === "any")
      .length;
    current.ts_expect_error += countDirectiveComments(sourceFile.getFullText());
  }

  return current;
}

function readBaseline(): Budget {
  const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("baseline must be a JSON object");
  }
  const baseline = {} as Budget;
  for (const metric of METRICS) {
    if (!Number.isInteger(parsed[metric]) || parsed[metric] < 0) {
      throw new Error(`baseline.${metric} must be a non-negative integer`);
    }
    baseline[metric] = parsed[metric];
  }
  return baseline;
}

function main(): void {
  const baseline = readBaseline();
  const current = countBudget();
  const delta = Object.fromEntries(
    METRICS.map((metric) => [metric, current[metric] - baseline[metric]]),
  ) as Budget;
  const exceeded = METRICS.filter((metric) => delta[metric] > 0);
  const report = { baseline, current, delta, exceeded, ok: exceeded.length === 0 };
  console.log(JSON.stringify(report, null, 2));
  if (exceeded.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`type-budget: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
