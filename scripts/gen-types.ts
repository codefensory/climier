#!/usr/bin/env bun

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Project, SyntaxKind, type ArrayLiteralExpression, type Expression } from "ts-morph";
import { ERROR_CODES, ERROR_CODES_BY_DOMAIN } from "../src/contracts/errors.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPERATION_GROUPS = Object.freeze([
  Object.freeze({ declaration: "TASK_OPERATION_IDS", kind: "task" }),
  Object.freeze({ declaration: "GATE_OPERATION_IDS", kind: "gate" }),
  Object.freeze({ declaration: "KNOWLEDGE_OPERATION_IDS", kind: "knowledge" }),
  Object.freeze({ declaration: "CORE_OPERATION_IDS", kind: "core" }),
]);

type ErrorCodesByDomain = Record<string, string[]>;
type CommandFlags = Record<string, string[]>;
type OperationKind = "task" | "gate" | "knowledge" | "core";
type RegisteredOperation = { id: string; kind: OperationKind };

export interface TypeCatalogs {
  errorCodesByDomain: ErrorCodesByDomain;
  errorCodes: string[];
  commandFlags: CommandFlags;
  operations: RegisteredOperation[];
}

function projectForAst(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
}

function unwrapArrayExpression(expression: Expression, source: string, name: string): ArrayLiteralExpression {
  let current = expression;
  for (;;) {
    if (current.isKind(SyntaxKind.ArrayLiteralExpression)) {
      return current;
    }
    if (current.isKind(SyntaxKind.AsExpression)) {
      current = current.getExpression();
      continue;
    }
    if (current.isKind(SyntaxKind.ParenthesizedExpression)) {
      current = current.getExpression();
      continue;
    }
    if (current.isKind(SyntaxKind.CallExpression)) {
      const args = current.getArguments();
      if (args.length === 1 && args[0].isKind(SyntaxKind.ArrayLiteralExpression)) {
        return args[0];
      }
    }
    throw new Error(`gen-types: ${source} catalog ${name} must be a literal string array`);
  }
}

function stringArrayFromSource(sourceFile: ReturnType<Project["addSourceFileAtPath"]>, name: string): string[] {
  const declaration = sourceFile.getVariableDeclaration(name);
  if (!declaration) {
    throw new Error(`gen-types: ${sourceFile.getFilePath()} is missing ${name}`);
  }
  const initializer = declaration.getInitializer();
  if (!initializer) {
    throw new Error(`gen-types: ${sourceFile.getFilePath()} catalog ${name} has no initializer`);
  }
  const array = unwrapArrayExpression(initializer, sourceFile.getFilePath(), name);
  return array.getElements().map((element) => {
    if (!element.isKind(SyntaxKind.StringLiteral) && !element.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
      throw new Error(`gen-types: ${sourceFile.getFilePath()} catalog ${name} contains a non-literal value`);
    }
    const value = element.getLiteralValue();
    if (typeof value !== "string") {
      throw new Error(`gen-types: ${sourceFile.getFilePath()} catalog ${name} contains a non-string value`);
    }
    return value;
  });
}

async function readCommandFlags(root: string): Promise<CommandFlags> {
  const commandDir = path.join(root, "src", "cli", "commands");
  const entries = await fs.readdir(commandDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .toSorted();
  const project = projectForAst();
  const flags: CommandFlags = {};
  for (const file of files) {
    const command = file.slice(0, -3);
    const sourceFile = project.addSourceFileAtPath(path.join(commandDir, file));
    if (!sourceFile.getDefaultExportSymbol()) {
      continue;
    }
    flags[command] = stringArrayFromSource(sourceFile, "knownFlags");
  }
  return flags;
}

async function readRegisteredOperations(root: string): Promise<RegisteredOperation[]> {
  const project = projectForAst();
  const sourceFile = project.addSourceFileAtPath(path.join(root, "src", "application", "operations", "builtins.ts"));
  const operations: RegisteredOperation[] = [];
  const seen = new Set<string>();
  for (const { declaration, kind } of OPERATION_GROUPS) {
    for (const id of stringArrayFromSource(sourceFile, declaration)) {
      if (seen.has(id)) {
        throw new Error(`gen-types: duplicate registered operation ${id}`);
      }
      seen.add(id);
      operations.push({ id, kind });
    }
  }
  return operations;
}

function readErrorCodes(): Pick<TypeCatalogs, "errorCodesByDomain" | "errorCodes"> {
  const errorCodesByDomain: ErrorCodesByDomain = {};
  for (const [domain, codes] of Object.entries(ERROR_CODES_BY_DOMAIN)) {
    errorCodesByDomain[domain] = Object.values(codes);
  }
  return {
    errorCodesByDomain,
    errorCodes: Object.values(ERROR_CODES),
  };
}

export async function collectCatalogs(root = ROOT): Promise<TypeCatalogs> {
  const errors = readErrorCodes();
  const [commandFlags, operations] = await Promise.all([
    readCommandFlags(root),
    readRegisteredOperations(root),
  ]);
  return {
    ...errors,
    commandFlags,
    operations,
  };
}

function canonicalCatalogJson(catalogs: TypeCatalogs): string {
  return JSON.stringify(catalogs);
}

export function catalogFingerprint(catalogs: TypeCatalogs): string {
  return createHash("sha256").update(canonicalCatalogJson(catalogs)).digest("hex");
}

function tsLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function generatedHeader(): string {
  return "// Generated by scripts/gen-types.ts. Do not edit by hand.\n\n";
}

function renderErrors(catalogs: TypeCatalogs): string {
  return `${generatedHeader()}export const GENERATED_ERROR_CODES_BY_DOMAIN = ${tsLiteral(catalogs.errorCodesByDomain)} as const;\n\nexport const GENERATED_ERROR_CODES = ${tsLiteral(catalogs.errorCodes)} as const;\n\nexport type GeneratedErrorCode = (typeof GENERATED_ERROR_CODES)[number];\nexport type GeneratedErrorDomain = keyof typeof GENERATED_ERROR_CODES_BY_DOMAIN;\n\nexport const ERROR_CODES_BY_DOMAIN = GENERATED_ERROR_CODES_BY_DOMAIN;\nexport const ERROR_CODES = GENERATED_ERROR_CODES;\nexport type ErrorCode = GeneratedErrorCode;\n`;
}

function renderCommands(catalogs: TypeCatalogs): string {
  return `${generatedHeader()}export const GENERATED_COMMAND_FLAGS = ${tsLiteral(catalogs.commandFlags)} as const;\n\nexport type GeneratedCommand = keyof typeof GENERATED_COMMAND_FLAGS;\nexport type GeneratedCommandFlag<C extends GeneratedCommand = GeneratedCommand> =\n  (typeof GENERATED_COMMAND_FLAGS)[C][number];\n\nexport const KNOWN_FLAGS_BY_COMMAND = GENERATED_COMMAND_FLAGS;\n`;
}

function renderOperations(catalogs: TypeCatalogs): string {
  const operationIds = catalogs.operations.map(({ id }) => id);
  return `${generatedHeader()}export const GENERATED_OPERATIONS = ${tsLiteral(catalogs.operations)} as const;\n\nexport const GENERATED_OPERATION_IDS = ${tsLiteral(operationIds)} as const;\n\nexport type GeneratedOperation = (typeof GENERATED_OPERATIONS)[number];\nexport type GeneratedOperationId = GeneratedOperation["id"];\nexport type GeneratedProviderKind = GeneratedOperation["kind"];\n\nexport const REGISTERED_OPERATIONS = GENERATED_OPERATIONS;\nexport const OPERATION_IDS = GENERATED_OPERATION_IDS;\n`;
}

function renderIndex(catalogs: TypeCatalogs): string {
  const fingerprint = catalogFingerprint(catalogs);
  return `${generatedHeader()}export * from "./errors.ts";\nexport * from "./commands.ts";\nexport * from "./operations.ts";\n\nimport { GENERATED_ERROR_CODES, GENERATED_ERROR_CODES_BY_DOMAIN } from "./errors.ts";\nimport { GENERATED_COMMAND_FLAGS } from "./commands.ts";\nimport { GENERATED_OPERATIONS } from "./operations.ts";\n\nexport const GENERATED_CATALOG = {\n  errorCodesByDomain: GENERATED_ERROR_CODES_BY_DOMAIN,\n  errorCodes: GENERATED_ERROR_CODES,\n  commandFlags: GENERATED_COMMAND_FLAGS,\n  operations: GENERATED_OPERATIONS,\n} as const;\n\nexport const GENERATED_CATALOG_FINGERPRINT = "${fingerprint}" as const;\n`;
}

export function renderGeneratedFiles(catalogs: TypeCatalogs): Record<string, string> {
  return {
    "errors.ts": renderErrors(catalogs),
    "commands.ts": renderCommands(catalogs),
    "operations.ts": renderOperations(catalogs),
    "index.ts": renderIndex(catalogs),
  };
}

export async function writeGeneratedFiles(root = ROOT): Promise<Record<string, string>> {
  const catalogs = await collectCatalogs(root);
  const files = renderGeneratedFiles(catalogs);
  const outputDir = path.join(root, "src", "contracts", "generated");
  await fs.mkdir(outputDir, { recursive: true });
  for (const [name, content] of Object.entries(files).toSorted(([left], [right]) => left.localeCompare(right))) {
    await fs.writeFile(path.join(outputDir, name), content, "utf8");
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await writeGeneratedFiles();
  console.log(`gen-types: wrote deterministic catalogs (${catalogFingerprint(await collectCatalogs())})`);
}
