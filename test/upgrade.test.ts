import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { installBinary } from "../src/upgrade/install.ts";
import upgrade from "../src/cli/commands/upgrade.ts";

const context = (projectDir: string, flags = {}) => ({
  command: "upgrade",
  originalArgv: [],
  flags,
  positional: [],
  projectDir,
  statePath: projectDir,
  projectConfig: {},
});

test("binary installation verifies the digest before replacing the target", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "climier-upgrade-"));
  const target = path.join(directory, "climier");
  await fs.writeFile(target, "old");
  const bytes = Buffer.from("new");
  const artifact = {
    url: "https://example.test/climier",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  const fetchImpl = async () => new Response(bytes);
  try {
    await installBinary({ artifact, targetPath: target, fetchImpl });
    assert.equal(await fs.readFile(target, "utf8"), "new");

    await fs.writeFile(target, "still-new");
    await assert.rejects(
      installBinary({ artifact: { ...artifact, sha256: "0".repeat(64) }, targetPath: target, fetchImpl }),
      (error: { code?: string }) => error.code === "UPGRADE_CHECKSUM_MISMATCH",
    );
    assert.equal(await fs.readFile(target, "utf8"), "still-new");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("source-link upgrade prints instructions without fetching or editing files", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "climier-upgrade-source-"));
  const oldRepository = process.env.CLIMIER_UPDATE_REPOSITORY;
  try {
    delete process.env.CLIMIER_UPDATE_REPOSITORY;
    const result = await upgrade(context(project, { version: "1.0.0" }));
    if (!("instructions" in result)) {
      throw new Error(`expected source-link distribution, got ${result.distribution}`);
    }
    assert.equal(result.updated, false);
    assert.match(result.instructions, /not updated automatically/);
  } finally {
    if (oldRepository === undefined) delete process.env.CLIMIER_UPDATE_REPOSITORY;
    else process.env.CLIMIER_UPDATE_REPOSITORY = oldRepository;
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("upgrade refuses to run while the project lock is present", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "climier-upgrade-active-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-upgrade-home-"));
  const oldHome = process.env.CLIMIER_HOME;
  try {
    await fs.writeFile(path.join(project, ".climier.json"), JSON.stringify({ version: 1, project_id: "active-project" }));
    await fs.mkdir(path.join(home, "projects", "active-project"), { recursive: true });
    await fs.writeFile(path.join(home, "projects", "active-project", ".lock"), "active");
    process.env.CLIMIER_HOME = home;
    await assert.rejects(
      upgrade(context(project)),
      (error: { code?: string }) => error.code === "UPGRADE_FLOW_ACTIVE",
    );
  } finally {
    if (oldHome === undefined) { delete process.env.CLIMIER_HOME; }
    else { process.env.CLIMIER_HOME = oldHome; }
    await fs.rm(project, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("upgrade check reports the manifest schema and update availability", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "climier-upgrade-check-"));
  const oldDistribution = process.env.CLIMIER_DISTRIBUTION;
  const oldRepository = process.env.CLIMIER_UPDATE_REPOSITORY;
  type BunServeOptions = {
    port: number;
    fetch(request: { url: string }): unknown;
  };
  const bun = (globalThis as typeof globalThis & {
    Bun: { serve(options: BunServeOptions): { port: number; stop(): void } };
  }).Bun;
  const server = bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/releases/latest/download/manifest.json") return new Response("not found", { status: 404 });
      return Response.json({
        manifest_version: 1,
        version: "2.0.1",
        release_channel: "stable",
        state_schema: 2,
        min_bun: ">=1.4",
        notes_url: "https://example.test/notes",
        artifacts: {},
      });
    },
  });
  try {
    process.env.CLIMIER_DISTRIBUTION = "binary";
    process.env.CLIMIER_UPDATE_REPOSITORY = `http://127.0.0.1:${server.port}`;
    const result = await upgrade(context(project, { check: true }));
    if (!("checked" in result)) {
      throw new Error("expected upgrade check result");
    }
    assert.deepEqual({
      latest_version: result.latest_version,
      update_available: result.update_available,
      state_schema: result.state_schema,
      migration_required: result.migration_required,
      checked: result.checked,
    }, {
      latest_version: "2.0.1",
      update_available: true,
      state_schema: 2,
      migration_required: true,
      checked: true,
    });
  } finally {
    server.stop();
    if (oldDistribution === undefined) delete process.env.CLIMIER_DISTRIBUTION;
    else process.env.CLIMIER_DISTRIBUTION = oldDistribution;
    if (oldRepository === undefined) delete process.env.CLIMIER_UPDATE_REPOSITORY;
    else process.env.CLIMIER_UPDATE_REPOSITORY = oldRepository;
    await fs.rm(project, { recursive: true, force: true });
  }
});
