import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CommitMessageError,
  validateCommitMessage,
} from "../scripts/check-commit-msg.ts";

test("commit messages require a supported type and a DAG node", async () => {
  await assert.doesNotReject(() => validateCommitMessage("feat(cli): add URLs [T-123]", {
    nodeExists: async () => true,
  }));

  await assert.rejects(
    () => validateCommitMessage("feature: add URLs [T-123]", { nodeExists: async () => true }),
    (error: unknown) => error instanceof CommitMessageError && error.code === "INVALID_FORMAT",
  );
  await assert.rejects(
    () => validateCommitMessage("feat: add URLs", { nodeExists: async () => true }),
    (error: unknown) => error instanceof CommitMessageError && error.code === "INVALID_FORMAT",
  );
});

test("commit messages distinguish an unknown node from an unreachable DAG", async () => {
  await assert.rejects(
    () => validateCommitMessage("feat: add URLs [T-missing]", {
      nodeExists: async () => { throw new CommitMessageError("NODE_NOT_FOUND", "node does not exist"); },
    }),
    (error: unknown) => error instanceof CommitMessageError && error.code === "NODE_NOT_FOUND",
  );
  await assert.rejects(
    () => validateCommitMessage("feat: add URLs [T-123]", {
      nodeExists: async () => { throw new CommitMessageError("DAG_UNREACHABLE", "DAG unavailable"); },
    }),
    (error: unknown) => error instanceof CommitMessageError && error.code === "DAG_UNREACHABLE",
  );
});

test("merge, revert, autosquash, and release commits are exempt", async () => {
  for (const subject of [
    "Merge branch 'main'",
    'Revert "feat: add URLs [T-123]"',
    "fixup! feat: add URLs [T-123]",
    "squash! feat: add URLs [T-123]",
    "amend! feat: add URLs [T-123]",
    "release: v2.0.0",
    "chore(release): v2.0.0",
  ]) {
    await assert.doesNotReject(() => validateCommitMessage(subject, {
      nodeExists: async () => { throw new Error("must not query the DAG"); },
    }), subject);
  }
});

test("CLIMIER_COMMIT_NO_TASK skips node validation but keeps conventional format", async () => {
  await assert.doesNotReject(() => validateCommitMessage("feat: local change", {
    noTask: true,
    nodeExists: async () => { throw new Error("must not query the DAG"); },
  }));
  await assert.rejects(
    () => validateCommitMessage("not-conventional: local change", {
      noTask: true,
      nodeExists: async () => true,
    }),
    (error: unknown) => error instanceof CommitMessageError && error.code === "INVALID_FORMAT",
  );
});
