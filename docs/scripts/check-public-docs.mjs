import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "../..");
export const PUBLIC_FILES = [
  "docs/reference.md",
  "docs/PLUGINS.md",
  "docs/remote-server.md",
];
export const PUBLIC_CONTENT_ROOT = "docs/content/docs";

const FORBIDDEN_PATTERNS = [
  { code: "CLIENT_NAME", pattern: /vegsport/i, description: "client or project name" },
  { code: "PRIVATE_IP", pattern: /\b(?:10|127)\.\d+\.\d+\.\d+\b|\b192\.168\.\d+\.\d+\b|\b100\.\d+\.\d+\.\d+\b/, description: "private IP address" },
  { code: "INTERNAL_HOST", pattern: /\bagento\b|\bubuntu@|\/home\/ubuntu/i, description: "internal host or user" },
  { code: "INTERNAL_PROCESS", pattern: /\bADR-\d+\b|\.adrs(?:[\/\\]|$)|\.decisions(?:[\/\\]|$)|\.pi\/(?:[^\s)]*)|\.agents\/(?:[^\s)]*)|\bAGENTS\.md\b|\bCLIMIER-CHEATSHEET\b|\bskills\//i, description: "internal process or repository path" },
  { code: "INTERNAL_NODE_ID", pattern: /\b(?:T|G|K)-(?:re|ui|pg|pf|rar|rb)-[a-z0-9-]+\b/i, description: "internal node id" },
  { code: "SECRET_NAME", pattern: /\bCLIMIER_SERVER_PASSWORD\b/i, description: "secret name" },
  { code: "DEPLOY_ENV", pattern: /\.deploy\.env\b/i, description: "deployment environment file" },
  { code: "SERVER_ENV_VALUE", pattern: /\bserver\.env\b[^\n]*(?:=|\b(?:password|secret|token|value|base64)\b)/i, description: "server environment value" },
];

const INTERNAL_LINK_PATH = /(?:^|[\\/])(?:\.adrs|\.decisions|\.pi|\.agents|skills)(?:[\\/]|$)|(?:^|[\\/])(?:AGENTS\.md|CLIMIER-CHEATSHEET(?:\.[^\\/]*)?)$/i;
const MARKDOWN_LINK = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
const HTML_LINK = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;

function relativePath(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function isPublicPath(relative) {
  return PUBLIC_FILES.includes(relative) || relative === PUBLIC_CONTENT_ROOT || relative.startsWith(`${PUBLIC_CONTENT_ROOT}/`);
}

async function collectFiles(rootDir, relativeDir, files, violations) {
  const absoluteDir = path.join(rootDir, relativeDir);
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      violations.push({
        code: "SCAN_ERROR",
        file: relativeDir,
        line: 1,
        message: `cannot read public directory: ${error.message}`,
      });
    }
    return;
  }

  for (const entry of entries) {
    const childRelative = path.posix.join(relativeDir, entry.name);
    const childAbsolute = path.join(rootDir, childRelative);
    if (entry.isSymbolicLink()) {
      violations.push({
        code: "PUBLIC_SYMLINK",
        file: childRelative,
        line: 1,
        message: "public content must not be a symbolic link",
      });
    } else if (entry.isDirectory()) {
      await collectFiles(rootDir, childRelative, files, violations);
    } else if (entry.isFile()) {
      files.push({ relative: childRelative, absolute: childAbsolute });
    }
  }
}

async function publicFiles(rootDir) {
  const files = [];
  const violations = [];

  for (const relative of PUBLIC_FILES) {
    const absolute = path.join(rootDir, relative);
    try {
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) {
        violations.push({ code: "PUBLIC_SYMLINK", file: relative, line: 1, message: "public content must not be a symbolic link" });
      } else if (!entry.isFile()) {
        violations.push({ code: "PUBLIC_FILE_INVALID", file: relative, line: 1, message: "public file is not a regular file" });
      } else {
        files.push({ relative, absolute });
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        violations.push({ code: "PUBLIC_FILE_MISSING", file: relative, line: 1, message: "allowlisted public file is missing" });
      } else {
        violations.push({ code: "SCAN_ERROR", file: relative, line: 1, message: `cannot inspect public file: ${error.message}` });
      }
    }
  }

  await collectFiles(rootDir, PUBLIC_CONTENT_ROOT, files, violations);
  return { files, violations };
}

function lineDetails(text, index) {
  const line = text.slice(0, index).split("\n").length;
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return { line, column: index - lineStart + 1 };
}

function violation(file, text, index, pattern, message = pattern.description) {
  return {
    code: pattern.code,
    file,
    ...lineDetails(text, index),
    pattern: pattern.pattern.source,
    message,
  };
}

function stripLinkTarget(rawTarget) {
  const target = rawTarget.trim();
  if (!target || target.startsWith("#") || target.startsWith("/") || target.startsWith("//")) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(target)) return null;
  return target.split(/[?#]/, 1)[0];
}

async function checkRelativeLinks(rootDir, file, text) {
  const violations = [];
  const links = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) links.push({ target: match[1] ?? match[2], index: match.index });
  for (const match of text.matchAll(HTML_LINK)) links.push({ target: match[1], index: match.index });

  for (const link of links) {
    const target = stripLinkTarget(link.target);
    if (!target) continue;
    const normalizedTarget = target.split("\\").join("/");
    const source = path.join(rootDir, file);
    const targetAbsolute = path.resolve(path.dirname(source), target);
    const targetRelative = relativePath(rootDir, targetAbsolute);
    const targetInsideRoot = targetRelative !== ".." && !targetRelative.startsWith("../");
    if (!targetInsideRoot) continue;

    let targetIsFile = false;
    try {
      targetIsFile = (await lstat(targetAbsolute)).isFile();
    } catch (error) {
      if (error.code !== "ENOENT") {
        violations.push({ code: "LINK_SCAN_ERROR", file, ...lineDetails(text, link.index), message: `cannot inspect relative link: ${error.message}` });
      }
    }

    if ((targetIsFile && !isPublicPath(targetRelative)) || INTERNAL_LINK_PATH.test(normalizedTarget)) {
      violations.push({
        code: "INTERNAL_LINK",
        file,
        ...lineDetails(text, link.index),
        message: `relative link points to an internal repository file: ${link.target}`,
      });
    }
  }
  return violations;
}

export async function scanPublicDocs(rootDir = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(rootDir);
  const { files, violations } = await publicFiles(resolvedRoot);
  const contentViolations = [];

  for (const file of files) {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file.absolute));
    } catch (error) {
      contentViolations.push({ code: "UNREADABLE_FILE", file: file.relative, line: 1, message: `cannot decode public file as UTF-8: ${error.message}` });
      continue;
    }

    for (const forbidden of FORBIDDEN_PATTERNS) {
      const match = forbidden.pattern.exec(text);
      if (match) contentViolations.push(violation(file.relative, text, match.index, forbidden));
    }
    contentViolations.push(...await checkRelativeLinks(resolvedRoot, file.relative, text));
  }

  return { rootDir: resolvedRoot, files: files.map(({ relative }) => relative), violations: [...violations, ...contentViolations] };
}

export const checkPublicDocs = scanPublicDocs;
export { FORBIDDEN_PATTERNS };

function printReport(result) {
  if (result.violations.length === 0) {
    console.log(`Public docs guardrail passed (${result.files.length} files scanned).`);
    return;
  }

  console.error(`Public docs guardrail failed (${result.violations.length} violation(s)).`);
  for (const finding of result.violations) {
    console.error(`- ${finding.file}:${finding.line}:${finding.column ?? 1} [${finding.code}] ${finding.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printReport(await scanPublicDocs(process.argv[2] || DEFAULT_ROOT));
}
