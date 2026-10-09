import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanPublicDocs } from "./check-public-docs.mjs";

export const POSITIVE_FIXTURES = [
  { name: "generic task id", content: "T-example-public is ready." },
  { name: "auth task and gates", content: "T-auth-login depends on G-auth-review." },
  { name: "ordinary project owner", content: "Ask alice to review the result." },
  { name: "relative project example", content: "Run it from ./my-project." },
];

export const NEGATIVE_FIXTURES = [
  { name: "client name", code: "CLIENT_NAME", content: "This mentions VegSport." },
  { name: "private IP", code: "PRIVATE_IP", content: "The service is at 192.168.10.4." },
  { name: "internal host", code: "INTERNAL_HOST", content: "The internal host is agento." },
  { name: "internal ADR path", code: "INTERNAL_PROCESS", content: "Read .adrs/065-public-docs-boundary.md." },
  { name: "internal node id", code: "INTERNAL_NODE_ID", content: "T-re-release-check is internal." },
  { name: "secret", code: "SECRET_NAME", content: "CLIMIER_SERVER_PASSWORD=not-for-publication" },
  { name: "deployment environment", code: "DEPLOY_ENV", content: "Never publish .deploy.env." },
  { name: "server environment value", code: "SERVER_ENV_VALUE", content: "server.env has a value: SECRET=not-for-publication" },
  { name: "internal relative link", code: "INTERNAL_LINK", content: "[private](../.adrs/secret.md)" },
];

async function writeFixtureRoot(root, content) {
  const docs = path.join(root, "docs");
  const contentDocs = path.join(docs, "content", "docs");
  await mkdir(contentDocs, { recursive: true });
  for (const file of ["reference.md", "PLUGINS.md", "remote-server.md"]) {
    await writeFile(path.join(docs, file), "Public documentation fixture.\n");
  }
  await writeFile(path.join(contentDocs, "fixture.md"), content);
}

export async function runFixtures() {
  for (const fixture of POSITIVE_FIXTURES) {
    const root = await mkdtemp(path.join(os.tmpdir(), "climier-public-docs-positive-"));
    try {
      await writeFixtureRoot(root, fixture.content);
      const result = await scanPublicDocs(root);
      assert.deepEqual(result.violations, [], `positive fixture failed: ${fixture.name}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  for (const fixture of NEGATIVE_FIXTURES) {
    const root = await mkdtemp(path.join(os.tmpdir(), "climier-public-docs-negative-"));
    try {
      await writeFixtureRoot(root, fixture.content);
      const result = await scanPublicDocs(root);
      assert.ok(
        result.violations.some((item) => item.code === fixture.code),
        `negative fixture unexpectedly passed: ${fixture.name}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  return { positive: POSITIVE_FIXTURES.length, negative: NEGATIVE_FIXTURES.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const counts = await runFixtures();
  console.log(`Public-docs fixtures passed: ${counts.positive} positive, ${counts.negative} negative.`);
}
