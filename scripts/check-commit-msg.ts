#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const COMMIT_TYPES = Object.freeze([
  "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
]);

type CommitMessageErrorCode = "INVALID_FORMAT" | "NODE_NOT_FOUND" | "DAG_UNREACHABLE";

type NodeExists = (nodeId: string) => Promise<boolean>;

export class CommitMessageError extends Error {
  readonly code: CommitMessageErrorCode;

  constructor(code: CommitMessageErrorCode, message: string) {
    super(message);
    this.name = "CommitMessageError";
    this.code = code;
  }
}

type CommitMessageOptions = {
  noTask?: boolean;
  nodeExists?: NodeExists;
};

type ParsedSubject = {
  nodeId?: string;
};

const conventionalSubject = new RegExp(
  `^(?:${COMMIT_TYPES.join("|")})(?:\\([^()\\r\\n]+\\))?!?: .+?(?: \\[([^\\]\\s]+)\\])?$`,
);

function subjectOf(message: string): string {
  return message.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trimEnd();
}

function isExempt(subject: string): boolean {
  return /^(?:Merge |Revert |(?:fixup|squash|amend)!\s)/.test(subject)
    || /^release:\s+v\S+/i.test(subject)
    || /^chore\(release\)(?:!)?:/i.test(subject);
}

function parseSubject(subject: string, allowMissingNodeId: boolean): ParsedSubject {
  const match = conventionalSubject.exec(subject);
  if (!match) {
    throw new CommitMessageError(
      "INVALID_FORMAT",
      `invalid commit subject; expected <type>(<scope>)!: <subject> [<node-id>] (types: ${COMMIT_TYPES.join(", ")})`,
    );
  }
  const nodeId = match[1];
  if (!nodeId && !allowMissingNodeId) {
    throw new CommitMessageError("INVALID_FORMAT", "commit subject must end with [<node-id>]");
  }
  return { nodeId };
}

export async function validateCommitMessage(
  message: string,
  options: CommitMessageOptions = {},
): Promise<void> {
  const subject = subjectOf(message);
  if (isExempt(subject)) {
    return;
  }

  const noTask = options.noTask === true;
  const { nodeId } = parseSubject(subject, noTask);
  if (!nodeId || noTask) {
    return;
  }

  await verifyNode(nodeId, options.nodeExists ?? nodeExistsViaClimier);
}

async function verifyNode(nodeId: string, nodeExists: NodeExists): Promise<void> {
  try {
    if (!(await nodeExists(nodeId))) {
      throw new CommitMessageError("NODE_NOT_FOUND", `node ${nodeId} does not exist in the DAG`);
    }
  } catch (error) {
    if (error instanceof CommitMessageError) {
      throw error;
    }
    throw new CommitMessageError(
      "DAG_UNREACHABLE",
      `could not verify node ${nodeId} against the DAG: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandOutput(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const value = error as { stdout?: unknown; stderr?: unknown };
  return [value.stdout, value.stderr].filter((part) => typeof part === "string").join("\n");
}

async function nodeExistsViaClimier(nodeId: string): Promise<boolean> {
  try {
    await execFileAsync(process.env.CLIMIER_BIN || "climier", ["show", nodeId], {
      cwd: process.cwd(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (error) {
    if (/\bNODE_NOT_FOUND\b/.test(commandOutput(error))) {
      throw new CommitMessageError("NODE_NOT_FOUND", `node ${nodeId} does not exist in the DAG`);
    }
    throw new CommitMessageError(
      "DAG_UNREACHABLE",
      `could not verify node ${nodeId} against the DAG: ${errorMessage(error)}`,
    );
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const messageFile = argv[0];
  if (!messageFile) {
    throw new CommitMessageError("INVALID_FORMAT", "commit message file argument is required");
  }
  const message = await readFile(messageFile, "utf8");
  await validateCommitMessage(message, {
    noTask: env.CLIMIER_COMMIT_NO_TASK === "1",
  });
}

const invokedFile = process.argv[1] && path.resolve(process.argv[1]);
if (invokedFile && invokedFile === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const code = error instanceof CommitMessageError ? error.code : "DAG_UNREACHABLE";
    console.error(`commit-msg: ${code}: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
