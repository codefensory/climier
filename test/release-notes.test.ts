import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractChangelogSection, renderReleaseNotes } from "../scripts/release-notes.ts";

const CHANGELOG = `# Changelog

All notable changes to this project are documented here.

## [1.1.0] - 2026-10-10

### Features

- **cli:** name projects with a display name ([a81c494](https://example.test/commit/a81c494))

The project display name is now first-class.

## [1.0.1] - 2026-10-09

### Bug Fixes

- **server:** stop emitting systemd hardening ([279d8b7](https://example.test/commit/279d8b7))

## [1.0.0] - 2026-09-28

The first clean Climier release.
`;

test("extractChangelogSection returns the released section with its heading and stops at the next release", () => {
  const section = extractChangelogSection(CHANGELOG, "1.1.0");
  assert.equal(section, [
    "## [1.1.0] - 2026-10-10",
    "",
    "### Features",
    "",
    "- **cli:** name projects with a display name ([a81c494](https://example.test/commit/a81c494))",
    "",
    "The project display name is now first-class.",
  ].join("\n"));
});

test("extractChangelogSection rejects a missing version, a heading-only section, and a prefix match", () => {
  assert.equal(extractChangelogSection(CHANGELOG, "9.9.9"), null);
  assert.equal(extractChangelogSection("# Changelog\n\n## [2.0.0] - 2026-11-01\n", "2.0.0"), null);
  assert.equal(extractChangelogSection("# Changelog\n\n## [2.0.0-rc1] - 2026-11-01\n\n- x\n", "2.0.0"), null);
});

test("renderReleaseNotes appends the compare link only when a base tag and repository are known", () => {
  const withLink = renderReleaseNotes({ changelog: CHANGELOG, version: "1.1.0", compareBase: "v1.0.1", repository: "codefensory/climier" });
  assert.match(withLink, /^## \[1\.1\.0\] - 2026-10-10\n/);
  assert.match(withLink, /\n\n\*\*Full Changelog\*\*: https:\/\/github\.com\/codefensory\/climier\/compare\/v1\.0\.1\.\.\.v1\.1\.0\n$/);

  const withoutLink = renderReleaseNotes({ changelog: CHANGELOG, version: "1.1.0" });
  assert.doesNotMatch(withoutLink, /Full Changelog/);
  assert.match(withoutLink, /The project display name is now first-class\.\n$/);
});

test("renderReleaseNotes fails loudly when the changelog has no section for the version", () => {
  assert.throws(() => renderReleaseNotes({ changelog: CHANGELOG, version: "9.9.9" }), /no usable '## \[9\.9\.9\]' section/);
});

test("the repository CHANGELOG documents the version in package.json", () => {
  const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const notes = renderReleaseNotes({ changelog, version });
  assert.ok(notes.length > 40, "the release body is more than a heading");
});
