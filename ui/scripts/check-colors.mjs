#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const scanRoots = ["src", ".storybook", "index.html"];
const allowlist = new Set([
  "src/styles/tokens.css",
  ".storybook/preview.tsx",
  "index.html",
  "scripts/check-colors.mjs",
]);

const utilityPattern = /\b(?:bg|text|border)-(?:white|black)\b/gi;
const functionPattern = /\b(?:rgb|rgba|hsl|hsla)\(/gi;
const shadowPattern = /\bshadow-\[[^\]\r\n]*(?:#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:black|white)\b)[^\]\r\n]*\]/gi;
const hexPattern = /#[0-9a-f]{6}\b/gi;
const testFilePattern = /\.test\.[cm]?[jt]sx?$/i;
const themeMetadataPath = "src/modules/core/theme/theme.ts";

function maskComments(source) {
  const chars = [...source];
  let state = "code";

  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];

    if (state === "line") {
      if (current === "\n" || current === "\r") state = "code";
      else chars[index] = " ";
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (current !== "\n" && current !== "\r") {
        chars[index] = " ";
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      if (current === "\\") {
        index += 1;
      } else if ((state === "single" && current === "'") || (state === "double" && current === '"') || (state === "template" && current === "`")) {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      state = "block";
    } else if (current === "'") {
      state = "single";
    } else if (current === '"') {
      state = "double";
    } else if (current === "`") {
      state = "template";
    }
  }

  return chars.join("");
}

async function filesUnder(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }

  return files;
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function lineAt(source, offset) {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  const end = source.indexOf("\n", offset);
  return source.slice(start, end === -1 ? source.length : end);
}

function isNonStylingHex(relativePath, source, offset) {
  if (testFilePattern.test(relativePath)) return true;
  if (relativePath === themeMetadataPath) {
    return /\b(?:light|dark):\s*["']#[0-9a-f]{6}\b/i.test(lineAt(source, offset));
  }
  return false;
}

function findingsFor(relativePath, source) {
  if (allowlist.has(relativePath)) return [];

  const searchable = maskComments(source);
  const findings = [];

  function collect(pattern, include = true) {
    if (!include) return;
    for (const match of searchable.matchAll(pattern)) {
      findings.push({
        start: match.index,
        end: match.index + match[0].length,
        literal: match[0],
      });
    }
  }

  collect(utilityPattern);
  collect(functionPattern);
  collect(shadowPattern);
  for (const match of searchable.matchAll(hexPattern)) {
    if (isNonStylingHex(relativePath, source, match.index)) continue;
    findings.push({ start: match.index, end: match.index + match[0].length, literal: match[0] });
  }

  findings.sort((left, right) => left.start - right.start || right.end - left.end);
  const distinctFindings = [];
  for (const finding of findings) {
    if (distinctFindings.at(-1)?.end > finding.start) continue;
    distinctFindings.push(finding);
  }
  return distinctFindings;
}

const files = [];
for (const scanRoot of scanRoots) {
  if (scanRoot === "index.html") files.push(scanRoot);
  else files.push(...await filesUnder(scanRoot));
}

const violations = [];
for (const relativePath of files) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  for (const finding of findingsFor(relativePath, source)) {
    violations.push(`${relativePath}:${lineNumber(source, finding.start)}: ${finding.literal}`);
  }
}

if (violations.length > 0) {
  console.error("Color literals found:");
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
