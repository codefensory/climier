import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const COMMENT_ROOTS = ["src", "bin", "test"];
export const COMMENT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

const PROTECTED_DIRECTIVE = /\b(?:oxlint|eslint)-(?:disable|enable|ignore)(?:-next-line)?\b/i;
const PROTECTED_PRAGMA = /@(?:license|preserve|no.?cover|__PURE__)/i;
const PROTECTED_DURABILITY = /\b(?:fsync|rename|cas|high[- ]water|crash(?:\s+window)?|durab(?:ility|le)|atomic(?:ity)?|lock\s+file)\b/i;
const PROTECTED_ERROR_CONTRACT = /\b(?:error\s+code|code\s+(?:and|plus)\s+details|details\s+(?:object|shape)|error\.code)\b/i;
const PROTECTED_TEST_CONTRACT = /\b(?:contract|assert(?:ion)?|regression|fixture|invariant|must|should|expected|ensures?)\b/i;

export const PROHIBITED_PATTERNS = Object.freeze({
  provenance: /\b(?:legacy|formerly|previous(?:ly)?|used\s+to|before\s+(?:the|this)|v\d+(?:\.\d+)*|version\s+\d+|backward[- ]compat(?:ibility)?|histor(?:y|ical)|migrat(?:ed|ion)|deprecated)\b/i,
  task_or_adr: /\b(?:ADR|RFC|TASK|T-[A-Z0-9][A-Z0-9-]*|G-[A-Z0-9][A-Z0-9-]*)\b/i,
  commented_code: /^\s*(?:(?:const|let|var|return|throw)\b|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|function\s+|class\s+|import\s+|export\s+)|=>|;\s*$/i,
  banner: /^\s*(?:[-=*#_]){3,}\s*$/,
  documentation_mirror: /\b(?:schema|envelope|field(?:s)?|command(?:s)?|endpoint(?:s)?|json\s+(?:shape|format)|cli\s+(?:surface|reference))\b\s*[:{[]/i,
  narration: /^\s*(?:this|the|we|it|handle|return|create|build|set|get|check|ensure|parse|read|write|load|save|resolve|dispatch|send|add|remove|keep|allow|when|if)\b/i,
});

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function collectComment(text, start, end, kind) {
  const value = text.slice(start, end);
  const firstLine = lineNumberAt(text, start);
  const lines = value.split(/\r?\n/);
  return lines.map((content, index) => ({
    line: firstLine + index,
    text: content.replace(/^\s*\*?\s?/, "").replace(/\s*\*\/$/, "").trim(),
    kind,
  }));
}

export function extractComments(text) {
  const comments = [];
  let state = "code";
  let start = -1;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (state === "line") {
      if (character === "\n") {
        comments.push(...collectComment(text, start + 2, index, "line"));
        state = "code";
      }
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        comments.push(...collectComment(text, start + 2, index, "block"));
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state === "string") {
      if (character === "\\") index += 1;
      else if (character === quote) state = "code";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      state = "string";
      quote = character;
    } else if (character === "/" && next === "/") {
      state = "line";
      start = index;
    } else if (character === "/" && next === "*") {
      state = "block";
      start = index;
    }
  }
  if (state === "line") comments.push(...collectComment(text, start + 2, text.length, "line"));
  if (state === "block") comments.push(...collectComment(text, start + 2, text.length, "block"));
  return comments;
}

export function isProtectedComment(comment, filePath) {
  const text = comment.text;
  if (PROTECTED_DIRECTIVE.test(text) || PROTECTED_PRAGMA.test(text) || PROTECTED_DURABILITY.test(text) || PROTECTED_ERROR_CONTRACT.test(text)) return true;
  return filePath.startsWith("test/") && PROTECTED_TEST_CONTRACT.test(text);
}

export function classifyComments(comments, filePath) {
  const prohibited = Object.fromEntries(Object.keys(PROHIBITED_PATTERNS).map((name) => [name, 0]));
  let protectedLines = 0;
  for (const comment of comments) {
    if (isProtectedComment(comment, filePath)) {
      protectedLines += 1;
      continue;
    }
    for (const [name, pattern] of Object.entries(PROHIBITED_PATTERNS)) {
      if (pattern.test(comment.text)) prohibited[name] += 1;
    }
  }
  return {
    comment_lines: comments.length - protectedLines,
    protected_lines: protectedLines,
    prohibited,
    directives: comments.filter((comment) => PROTECTED_DIRECTIVE.test(comment.text)).length,
  };
}

async function findFiles(directory, rootDir, result) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await findFiles(absolute, rootDir, result);
    else if (entry.isFile() && COMMENT_EXTENSIONS.has(path.extname(entry.name))) {
      result.push(path.relative(rootDir, absolute).split(path.sep).join("/"));
    }
  }
}

export async function collectCommentBaselines(rootDir) {
  const paths = [];
  for (const relativeRoot of COMMENT_ROOTS) {
    await findFiles(path.join(rootDir, relativeRoot), rootDir, paths);
  }
  const files = [];
  for (const filePath of paths.toSorted()) {
    const text = await readFile(path.join(rootDir, filePath), "utf8");
    files.push({ path: filePath, ...classifyComments(extractComments(text), filePath) });
  }
  return files;
}

export function directiveCounts(files) {
  return Object.fromEntries(COMMENT_ROOTS.map((area) => [area, files
    .filter((file) => file.path === area || file.path.startsWith(`${area}/`))
    .reduce((sum, file) => sum + file.directives, 0)]));
}
