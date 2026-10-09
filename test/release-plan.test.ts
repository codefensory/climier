import assert from "node:assert/strict";
import test from "node:test";

import {
  bumpVersion,
  classifyCommit,
  isProductPath,
  planRelease,
  renderChangelog,
  selectBump,
  type CommitInput,
} from "../scripts/release-plan.ts";

function commit(subject: string, files: string[], body = ""): CommitInput {
  return { sha: "0123456789abcdef0123456789abcdef01234567", subject, body, files };
}

test("release-plan: only shipped code paths count (src/, bin/, ui/)", () => {
  for (const file of ["src/cli/dispatch.ts", "bin/climier.ts", "ui/src/App.tsx", "ui/package.json", "ui/vite.config.ts"]) {
    assert.equal(isProductPath(file), true, `${file} should be a product path`);
  }
  for (const file of [
    "package.json",
    "docs/reference.md",
    "docs/content/docs/index.mdx",
    ".pi/APPEND_SYSTEM.md",
    ".agents/skills/climier-release/SKILL.md",
    "skills/climier/SKILL.md",
    ".adrs/071-release-local-publish.md",
    ".decisions/G-release-engineering-rfc.md",
    "AGENTS.md",
    "CLIMIER-CHEATSHEET.md",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "test/release-plan.test.ts",
    "scripts/release-plan.ts",
    ".github/workflows/ci.yml",
    "bun.lock",
  ]) {
    assert.equal(isProductPath(file), false, `${file} should not be a product path`);
  }
});

test("release-plan: classifies feature, fix, breaking, and documentation commits", () => {
  const feature = classifyCommit(commit("feat(cli): add upgrade --check", ["src/cli/upgrade.ts"]));
  assert.equal(feature.type, "feat");
  assert.equal(feature.scope, "cli");
  assert.equal(feature.touchesProduct, true);
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
  assert.equal(docs.touchesProduct, false);
  assert.equal(docs.releaseWorthy, false);
});

test("release-plan: agent tooling, decision docs, tests and scripts never drive a release", () => {
  const nonProduct = [
    classifyCommit(commit("feat(skills): add the release skill", [".agents/skills/climier-release/SKILL.md"])),
    classifyCommit(commit("feat(release): add the version planner", ["scripts/release-plan.ts"])),
    classifyCommit(commit("fix(docs): resolve doc", ["docs/scripts/check-pages-artifact.mjs"])),
    classifyCommit(commit("feat(agents): routing cue", [".pi/APPEND_SYSTEM.md"])),
    classifyCommit(commit("test(release): cover the planner", ["test/release-plan.test.ts"])),
    classifyCommit(commit("ci: create the release when missing", [".github/workflows/ci.yml"])),
    // Adding a dev-tooling script to package.json is not a product change.
    classifyCommit(commit("feat(release): wire the release script", ["package.json"])),
  ];
  assert.equal(selectBump(nonProduct), "none");
  // A breaking marker does not help when no product path is touched.
  assert.equal(selectBump([classifyCommit(commit("feat(agents)!: drop the old cue", [".pi/APPEND_SYSTEM.md"]))]), "none");
});

test("release-plan: selects the highest applicable semver bump", () => {
  assert.equal(selectBump([classifyCommit(commit("chore: bump deps", ["package.json"]))]), "none");
  assert.equal(selectBump([classifyCommit(commit("feat(package): add engines", ["package.json"]))]), "none");
  assert.equal(selectBump([classifyCommit(commit("perf(core): cache", ["src/kernel/x.ts"]))]), "patch");
  assert.equal(selectBump([classifyCommit(commit("fix(bin): repair the shim", ["bin/climier.ts"]))]), "patch");
  assert.equal(selectBump([classifyCommit(commit("feat(ui): add the filter", ["ui/src/Filter.tsx"]))]), "minor");
  assert.equal(
    selectBump([
      classifyCommit(commit("fix(cli): y", ["src/cli/y.ts"])),
      classifyCommit(commit("refactor!: split the kernel", ["src/kernel/z.ts"])),
    ]),
    "major",
  );
  // A product path in a mixed commit still counts.
  assert.equal(
    selectBump([classifyCommit(commit("feat(cli): add x and document it", ["docs/reference.md", "src/cli/x.ts"]))]),
    "minor",
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

test("release-plan: plans a patch release and reports excluded non-product commits", () => {
  const plan = planRelease({
    baseTag: "v1.0.0",
    baseVersion: "1.0.0",
    commits: [
      commit("fix(cli): repair the flag", ["src/cli/commands/status.ts"]),
      commit("feat(release): add the planner", ["scripts/release-plan.ts"]),
      commit("docs: refresh the runbook", ["docs/remote-server.md"]),
    ],
  });
  assert.equal(plan.bump, "patch");
  assert.equal(plan.nextVersion, "1.0.1");
  assert.equal(plan.releaseWorthy, true);
  assert.equal(plan.excluded.length, 2);
  assert.match(plan.excluded[0].reason, /no product paths/u);
  assert.doesNotMatch(plan.changelog, /add the planner/u);
  assert.match(plan.changelog, /repair the flag/u);
});

test("release-plan: a non-product range proposes no release", () => {
  const plan = planRelease({
    baseTag: "v1.0.0",
    baseVersion: "1.0.0",
    commits: [
      commit("feat(skills): add the release skill", [".agents/skills/climier-release/SKILL.md"]),
      commit("docs: refresh", ["docs/reference.md"]),
    ],
  });
  assert.equal(plan.bump, "none");
  assert.equal(plan.nextVersion, "1.0.0");
  assert.equal(plan.releaseWorthy, false);
  assert.equal(plan.changelog, "");
});
