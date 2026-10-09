import assert from "node:assert/strict";
import test from "node:test";

import {
  bumpVersion,
  classifyCommit,
  isDocsPath,
  planRelease,
  renderChangelog,
  selectBump,
  type CommitInput,
} from "../scripts/release-plan.ts";

function commit(subject: string, files: string[], body = ""): CommitInput {
  return { sha: "0123456789abcdef0123456789abcdef01234567", subject, body, files };
}

test("release-plan: only paths outside docs/ are release-worthy", () => {
  assert.equal(isDocsPath("docs/reference.md"), true);
  assert.equal(isDocsPath("docs"), true);
  assert.equal(isDocsPath("src/cli/dispatch.ts"), false);
  assert.equal(isDocsPath("README.md"), false);
});

test("release-plan: classifies feature, fix, breaking, and documentation commits", () => {
  const feature = classifyCommit(commit("feat(cli): add upgrade --check", ["src/cli/upgrade.ts"]));
  assert.equal(feature.type, "feat");
  assert.equal(feature.scope, "cli");
  assert.equal(feature.releaseWorthy, true);
  assert.equal(feature.section, "Features");

  const fix = classifyCommit(commit("fix(server): adopt the operator password", ["src/server/setup-artifacts.ts"]));
  assert.equal(fix.releaseWorthy, true);
  assert.equal(fix.section, "Bug Fixes");

  const breaking = classifyCommit(commit("feat(state)!: drop the pre-cut reader", ["src/storage/state.ts"]));
  assert.equal(breaking.breaking, true);
  assert.equal(breaking.releaseWorthy, true);

  const footer = classifyCommit(commit("fix(cli): adjust output", ["src/cli/dispatch.ts"], "Details\n\nBREAKING CHANGE: envelope changed"));
  assert.equal(footer.breaking, true);

  const docs = classifyCommit(commit("docs(reference): update the flag table", ["docs/reference.md"]));
  assert.equal(docs.releaseWorthy, false);
  assert.equal(docs.section, "Documentation");
});

test("release-plan: docs-only changes never drive a release, even when typed feat", () => {
  const docsOnly = [classifyCommit(commit("feat(docs): add a guide", ["docs/content/docs/guides/x.mdx"]))];
  assert.equal(selectBump(docsOnly), "none");

  const mixed = [
    classifyCommit(commit("feat(docs): document the change", ["docs/reference.md", "src/cli/commands/x.ts"])),
    classifyCommit(commit("docs: polish", ["docs/reference.md"])),
  ];
  assert.equal(selectBump(mixed), "minor");
});

test("release-plan: selects the highest applicable semver bump", () => {
  assert.equal(selectBump([classifyCommit(commit("chore: bump deps", ["package.json"]))]), "none");
  assert.equal(selectBump([classifyCommit(commit("perf(core): cache", ["src/kernel/x.ts"]))]), "patch");
  assert.equal(selectBump([classifyCommit(commit("feat(cli): add x", ["src/cli/x.ts"]))]), "minor");
  assert.equal(
    selectBump([
      classifyCommit(commit("fix(cli): y", ["src/cli/y.ts"])),
      classifyCommit(commit("refactor!: split the kernel", ["src/kernel/z.ts"])),
    ]),
    "major",
  );
});

test("release-plan: bumps semver versions", () => {
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "none"), "1.2.3");
  assert.throws(() => bumpVersion("not-a-version", "patch"), /not semver/u);
});

test("release-plan: renders grouped changelog sections with breaking markers", () => {
  const changelog = renderChangelog([
    classifyCommit(commit("feat(cli): add x", ["src/cli/x.ts"])),
    classifyCommit(commit("feat(state)!: drop the old reader", ["src/storage/state.ts"])),
  ], "https://example.test/repo");
  assert.match(changelog, /### Features/u);
  assert.match(changelog, /- \*\*cli:\*\* add x \(\[[0-9a-f]{7}\]\(https:\/\/example\.test\/repo\/commit\/[0-9a-f]{40}\)\)/u);
  assert.match(changelog, /\*\*BREAKING\*\*/u);
});

test("release-plan: plans a patch release and flags a docs-only change set", () => {
  const patch = planRelease({
    baseTag: "v1.0.0",
    baseVersion: "1.0.0",
    commits: [commit("fix(cli): repair the flag", ["src/cli/commands/status.ts"])],
  });
  assert.equal(patch.bump, "patch");
  assert.equal(patch.nextVersion, "1.0.1");
  assert.equal(patch.releaseWorthy, true);
  assert.equal(patch.docsOnly, false);

  const docsOnly = planRelease({
    baseTag: "v1.0.0",
    baseVersion: "1.0.0",
    commits: [commit("docs: refresh the runbook", ["docs/remote-server.md"])],
  });
  assert.equal(docsOnly.bump, "none");
  assert.equal(docsOnly.nextVersion, "1.0.0");
  assert.equal(docsOnly.releaseWorthy, false);
  assert.equal(docsOnly.docsOnly, true);
});
