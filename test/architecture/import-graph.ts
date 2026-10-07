import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const IDENTIFIER = /[$\w]/u;

type Token = { type: "string" | "identifier" | "punctuation"; value: string; line: number };
type TokenResult = { token?: Token; index: number; line: number };
type ImportRecord = { sourceFile: string; targetFile: string; specifier?: string };
type CollectOptions = { sourceRootDirectory?: string; targetRootDirectory?: string };

function isIdentifierStart(character) {
  return Boolean(character) && (character === "_" || character === "$" || /[A-Za-z]/u.test(character));
}

function isIdentifierPart(character) {
  return Boolean(character) && (character === "_" || character === "$" || IDENTIFIER.test(character));
}

function skipWhitespace(source: string, index: number, line: number): { index: number; line: number } {
  while (index < source.length && /\s/u.test(source[index])) {
    if (source[index] === "\n") {
      line += 1;
    }
    index += 1;
  }
  return { index, line };
}

function skipLineComment(source: string, index: number): number {
  while (index < source.length && source[index] !== "\n") {
    index += 1;
  }
  return index;
}

function skipBlockComment(source: string, index: number, line: number): { index: number; line: number } {
  while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
    if (source[index] === "\n") {
      line += 1;
    }
    index += 1;
  }
  return { index: index + 2, line };
}

function readQuotedString(source: string, index: number, line: number): TokenResult {
  const quote = source[index];
  const start = index;
  index += 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "\n") {
      line += 1;
    }
    if (source[index] === quote) {
      index += 1;
      break;
    }
    index += 1;
  }
  return {
    token: { type: "string", value: source.slice(start + 1, index - 1), line },
    index,
    line,
  };
}

function skipTemplate(source: string, index: number, line: number): { index: number; line: number } {
  index += 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "\n") {
      line += 1;
    }
    if (source[index] === "`") {
      index += 1;
      break;
    }
    index += 1;
  }
  return { index, line };
}

function readIdentifier(source: string, index: number, line: number): TokenResult {
  const start = index;
  while (isIdentifierPart(source[index])) {
    index += 1;
  }
  return {
    token: { type: "identifier", value: source.slice(start, index), line },
    index,
    line,
  };
}

function readComment(source: string, index: number, line: number): TokenResult | undefined {
  if (source[index] !== "/") {
    return undefined;
  }
  if (source[index + 1] === "/") {
    return { index: skipLineComment(source, index + 2), line, token: undefined };
  }
  if (source[index + 1] === "*") {
    return { ...skipBlockComment(source, index + 2, line), token: undefined };
  }
  return undefined;
}

function readLiteral(source: string, index: number, line: number): TokenResult {
  if (source[index] === "'" || source[index] === '"') {
    return readQuotedString(source, index, line);
  }
  return { ...skipTemplate(source, index, line), token: undefined };
}

function nextToken(source: string, index: number, line: number): TokenResult {
  const character = source[index];
  if (/\s/u.test(character)) {
    return { ...skipWhitespace(source, index, line), token: undefined };
  }
  const comment = readComment(source, index, line);
  if (comment !== undefined) {
    return comment;
  }
  if (character === "'" || character === '"' || character === "`") {
    return readLiteral(source, index, line);
  }
  if (isIdentifierStart(character)) {
    return readIdentifier(source, index, line);
  }
  return { token: { type: "punctuation", value: character, line }, index: index + 1, line };
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const result = nextToken(source, index, line);
    if (result.token !== undefined) {
      tokens.push(result.token);
    }
    index = result.index;
    line = result.line;
  }

  return tokens;
}

function isImportOrExport(token: Token): boolean {
  return token.type === "identifier" && (token.value === "import" || token.value === "export");
}

function dynamicImportSpecifier(tokens: Token[], index: number): string | undefined {
  const specifier = tokens[index + 2];
  return specifier?.type === "string" ? specifier.value : undefined;
}

function declarationImportSpecifier(tokens: Token[], index: number): string | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].value === ";") {
      break;
    }
    if (tokens[cursor].value === "from") {
      const specifier = tokens[cursor + 1];
      return specifier?.type === "string" ? specifier.value : undefined;
    }
  }
  return undefined;
}

function importSpecifier(tokens: Token[], index: number): string | undefined {
  const token = tokens[index];
  const next = tokens[index + 1];
  if (token.value === "import" && next?.value === "(") {
    return dynamicImportSpecifier(tokens, index);
  }
  if (token.value === "import" && next?.type === "string") {
    return next.value;
  }
  return declarationImportSpecifier(tokens, index);
}

export function relativeImportSpecifiers(source: string): string[] {
  const tokens = tokenize(source);
  const specifiers: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (!isImportOrExport(tokens[index])) {
      continue;
    }
    const specifier = importSpecifier(tokens, index);
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }

  return specifiers.filter((specifier) => specifier.startsWith("."));
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(entryPath));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs"))) {
      files.push(entryPath);
    }
  }
  return files.toSorted();
}

export async function collectRelativeImports(directory: string, {
  sourceRootDirectory,
  targetRootDirectory,
}: CollectOptions = {}): Promise<ImportRecord[]> {
  const sourceDirectory = path.resolve(directory);
  let sourceRoot = sourceRootDirectory === undefined
    ? sourceDirectory
    : path.resolve(sourceRootDirectory);
  if (sourceRootDirectory === undefined) {
    while (path.basename(sourceRoot) !== "src") {
      const parent = path.dirname(sourceRoot);
      if (parent === sourceRoot) {
        throw new Error(`collectRelativeImports: ${directory} is not under src`);
      }
      sourceRoot = parent;
    }
  }
  const targetRoot = targetRootDirectory === undefined
    ? sourceRoot
    : path.resolve(targetRootDirectory);
  const files = await sourceFiles(sourceDirectory);
  const imports: ImportRecord[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const target = path.resolve(path.dirname(file), specifier);
      imports.push({
        sourceFile: path.relative(sourceRoot, file),
        targetFile: path.relative(targetRoot, target),
        specifier,
      });
    }
  }

  return imports;
}

export function findBoundaryViolations(imports: ImportRecord[], { sourceRoot, forbiddenRoots }: { sourceRoot: string; forbiddenRoots: string[] }): ImportRecord[] {
  return imports.filter(({ sourceFile, targetFile }) => {
    const sourceMatches = sourceFile === sourceRoot || sourceFile.startsWith(`${sourceRoot}${path.sep}`);
    const targetRoot = targetFile.split(path.sep)[0];
    return sourceMatches && forbiddenRoots.includes(targetRoot);
  });
}
