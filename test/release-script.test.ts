import assert from "node:assert/strict";
import test from "node:test";

import {
  assertChangelogHasVersion,
  decideTagAction,
  distTagFor,
  parseReleaseArgs,
  releaseTagFor,
} from "../scripts/release.ts";

test("release: derives the tag and npm dist-tag from the version", () => {
  assert.equal(releaseTagFor("1.0.0"), "v1.0.0");
  assert.equal(distTagFor("1.0.0"), "latest");
  assert.equal(distTagFor("1.1.0-next.1"), "next");
});

test("release: accepts a changelog with the version section and rejects a missing one", () => {
  assert.doesNotThrow(() => assertChangelogHasVersion("1.0.0", "# Changelog\n\n## [1.0.0] - 2026-09-28\n"));
  assert.throws(
    () => assertChangelogHasVersion("1.0.0", "# Changelog\n\n## [0.9.0] - 2026-01-01\n"),
    /CHANGELOG\.md has no '## \[1\.0\.0\]' section/u,
  );
});

test("release: decides whether to create, reuse, or worktree the release tag", () => {
  assert.equal(decideTagAction({ headCommit: "aaaa" }), "create");
  assert.equal(decideTagAction({ existingCommit: "aaaa", headCommit: "aaaa" }), "reuse");
  assert.equal(decideTagAction({ existingCommit: "bbbb", headCommit: "aaaa" }), "worktree");
});

test("release: parses flags and rejects unknown arguments", () => {
  assert.deepEqual(parseReleaseArgs([]), { dryRun: false, skipGate: false, help: false });
  assert.deepEqual(parseReleaseArgs(["--dry-run", "--skip-gate"]), { dryRun: true, skipGate: true, help: false });
  assert.deepEqual(parseReleaseArgs(["--tag", "next"]), { dryRun: false, skipGate: false, help: false, distTag: "next" });
  assert.deepEqual(parseReleaseArgs(["--tag=latest"]), { dryRun: false, skipGate: false, help: false, distTag: "latest" });
  assert.throws(() => parseReleaseArgs(["--tag", "beta"]), /--tag must be latest or next/u);
  assert.throws(() => parseReleaseArgs(["--nope"]), /unknown argument '--nope'/u);
});
