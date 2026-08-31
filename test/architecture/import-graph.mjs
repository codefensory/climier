import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const IDENTIFIER = /[$\w]/u;

function isIdentifierStart(character) {
  return Boolean(character) && (character === "_" || character === "$" || /[A-Za-z]/u.test(character));
}

function isIdentifierPart(character) {
  return Boolean(character) && (character === "_" || character === "$" || IDENTIFIER.test(character));
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      if (character === "\n") line += 1;
      index += 1;
      continue;
    }

    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "\n") line += 1;
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ type: "string", value: source.slice(start + 1, index - 1), line });
      continue;
    }

    if (character === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "\n") line += 1;
        if (source[index] === "`") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (isIdentifierPart(source[index])) index += 1;
      tokens.push({ type: "identifier", value: source.slice(start, index), line });
      continue;
    }

    tokens.push({ type: "punctuation", value: character, line });
    index += 1;
  }

  return tokens;
}

export function relativeImportSpecifiers(source) {
  const tokens = tokenize(source);
  const specifiers = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier" || (token.value !== "import" && token.value !== "export")) continue;

    const next = tokens[index + 1];
    if (token.value === "import" && next?.value === "(") {
      const specifier = tokens[index + 2];
      if (specifier?.type === "string") specifiers.push(specifier.value);
      continue;
    }

    if (token.value === "import" && next?.type === "string") {
      specifiers.push(next.value);
      continue;
    }

    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].value === ";") break;
      if (tokens[cursor].value !== "from") continue;
      const specifier = tokens[cursor + 1];
      if (specifier?.type === "string") specifiers.push(specifier.value);
      break;
    }
  }

  return specifiers.filter((specifier) => specifier.startsWith("."));
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(entryPath);
  }
  return files.sort();
}

export async function collectRelativeImports(directory) {
  const sourceDirectory = path.resolve(directory);
  let sourceRoot = sourceDirectory;
  while (path.basename(sourceRoot) !== "src") {
    const parent = path.dirname(sourceRoot);
    if (parent === sourceRoot) throw new Error(`collectRelativeImports: ${directory} is not under src`);
    sourceRoot = parent;
  }
  const files = await sourceFiles(sourceDirectory);
  const imports = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const target = path.resolve(path.dirname(file), specifier);
      imports.push({
        sourceFile: path.relative(sourceRoot, file),
        targetFile: path.relative(sourceRoot, target),
        specifier,
      });
    }
  }

  return imports;
}

export function findBoundaryViolations(imports, { sourceRoot, forbiddenRoots }) {
  return imports.filter(({ sourceFile, targetFile }) => {
    const sourceMatches = sourceFile === sourceRoot || sourceFile.startsWith(`${sourceRoot}${path.sep}`);
    const targetRoot = targetFile.split(path.sep)[0];
    return sourceMatches && forbiddenRoots.includes(targetRoot);
  });
}
