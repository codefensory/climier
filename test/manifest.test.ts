import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateManifest } from "../scripts/manifest.ts";

const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;

async function makeDist(t: { after: (callback: () => void | Promise<void>) => void }, missing?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-manifest-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dist = path.join(root, "dist");
  await fs.mkdir(dist);
  for (const platform of platforms) {
    if (platform === missing) {continue;}
    const suffix = platform === "windows-x64" ? ".exe" : "";
    await fs.writeFile(path.join(dist, `climier-${platform}${suffix}`), `binary:${platform}`);
  }
  return { dist, out: path.join(root, "manifest.json") };
}

test("manifest: generates a v1 release manifest for every supported platform", async (t) => {
  const { dist, out } = await makeDist(t);
  const manifest = await generateManifest({ version: "1.0.0", channel: "stable", dist, out });

  assert.deepEqual(Object.keys(manifest), [
    "manifest_version",
    "version",
    "release_channel",
    "state_schema",
    "min_bun",
    "notes_url",
    "artifacts",
  ]);
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.release_channel, "stable");
  assert.equal(manifest.state_schema, 1);
  assert.equal(manifest.min_bun, ">=1.4");
  assert.equal(manifest.notes_url, "https://github.com/codefensory/climier/releases/tag/v1.0.0");
  assert.deepEqual(Object.keys(manifest.artifacts), platforms);

  for (const platform of platforms) {
    const suffix = platform === "windows-x64" ? ".exe" : "";
    const file = path.join(dist, `climier-${platform}${suffix}`);
    const bytes = await fs.readFile(file);
    assert.deepEqual(manifest.artifacts[platform], {
      url: `https://github.com/codefensory/climier/releases/download/v1.0.0/climier-${platform}${suffix}`,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    });
  }
  assert.deepEqual(JSON.parse(await fs.readFile(out, "utf8")), manifest);
});

test("manifest: rejects an incomplete dist before writing output", async (t) => {
  const { dist, out } = await makeDist(t, "darwin-arm64");

  await assert.rejects(
    generateManifest({ version: "1.0.0", channel: "stable", dist, out }),
    /manifest: missing artifact for darwin-arm64/,
  );
  await assert.rejects(fs.access(out), { code: "ENOENT" });
});
