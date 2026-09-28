import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkCommentPolicy } from "../scripts/check-comment-policy.mjs";
import { generateCommentManifest } from "../scripts/generate-comment-manifest.mjs";

async function fixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "climier-comment-policy-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "src", "fixture.mjs"), source);
  return root;
}

function manifest(file) {
  return { version: 1, files: [{ path: "src/fixture.mjs", ...file }], directive_counts: { src: 0, bin: 0, test: 0 } };
}

test("comment checker rejects a newly introduced prohibited pattern", async () => {
  const root = await fixture("// ADR-123 explains why this is here\nexport const value = 1;\n");
  try {
    const result = await checkCommentPolicy({ root, manifest: manifest({ comment_lines: 0, protected_lines: 0, prohibited: {} }) });
    assert.ok(result.issues.some((issue) => issue.includes("prohibited task_or_adr")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comment checker rejects a file that grows above its baseline", async () => {
  const root = await fixture("// ordinary explanation\nexport const value = 1;\n");
  try {
    const result = await checkCommentPolicy({ root, manifest: manifest({ comment_lines: 0, protected_lines: 0, prohibited: {} }) });
    assert.ok(result.issues.some((issue) => issue.includes("comment baseline grew")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protected lint directives are excluded from the comment baseline", async () => {
  const root = await fixture("// oxlint-disable-next-line complexity -- contract\nexport const value = 1;\n");
  try {
    const result = await checkCommentPolicy({
      root,
      manifest: manifest({ comment_lines: 0, protected_lines: 1, directives: 1, prohibited: {} }),
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.files[0].comment_lines, 0);
    assert.equal(result.directive_counts.src, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation only ratchets comment baselines downward", async () => {
  const root = await fixture("// ordinary explanation\nexport const value = 1;\n");
  try {
    await assert.rejects(
      generateCommentManifest({ root, previous: manifest({ comment_lines: 0, protected_lines: 0, prohibited: {} }) }),
      /comment baseline grew/,
    );
    const generated = await generateCommentManifest({ root, previous: manifest({ comment_lines: 2, protected_lines: 0, prohibited: {} }) });
    assert.equal(generated.files[0].comment_lines, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
