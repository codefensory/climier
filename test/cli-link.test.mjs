import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { createTempProject, rmTempProject, runCli, stateFilePath, writeCanonicalState } from "./helpers.mjs";

async function readMeta(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8"));
}

async function runLink(dir, args = []) {
  return runCli(["--project", dir, "link", ...args]);
}

test("remote metadata without protocol v2 fails before local state access", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({
      version: 1,
      project_id: "legacy-id",
      backend: { type: "remote", url: "https://old.example.test/" },
    }, null, 2) + "\n");

    for (const args of [["status"], ["status", "link"]]) {
      const result = await runCli(["--project", dir, ...args]);
      assert.equal(result.code, 1, result.stdout);
      const out = JSON.parse(result.stdout);
      assert.equal(out.error.code, "REMOTE_CONFIG_OUTDATED");
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("link writes remote v2 metadata and generates an id when metadata is missing", async () => {
  const dir = await createTempProject();
  try {
    const result = await runLink(dir, ["https://climier.example.test"]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      project: {
        project_id: (await readMeta(dir)).project_id,
        backend: { type: "remote", url: "https://climier.example.test/", protocol: "v2" },
      },
    });
    const meta = await readMeta(dir);
    assert.equal(meta.version, 1);
    assert.match(meta.project_id, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(meta.backend, { type: "remote", url: "https://climier.example.test/", protocol: "v2" });
  } finally {
    await rmTempProject(dir);
  }
});

test("link preserves the existing project id and is idempotent for the same origin", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({ version: 1, project_id: "kept-id" }, null, 2) + "\n");
    let result = await runLink(dir, ["https://climier.example.test/root"]);
    assert.equal(result.code, 0, result.stdout);
    const firstRaw = await fs.readFile(path.join(dir, ".climier.json"), "utf8");
    assert.equal((await readMeta(dir)).project_id, "kept-id");

    result = await runLink(dir, ["https://climier.example.test/root"]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(await fs.readFile(path.join(dir, ".climier.json"), "utf8"), firstRaw);
  } finally {
    await rmTempProject(dir);
  }
});

test("link can relink outdated remote metadata without reading remote or local state", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({
      version: 1,
      project_id: "legacy-id",
      backend: { type: "remote", url: "https://old.example.test/" },
    }, null, 2) + "\n");

    const result = await runLink(dir, ["https://old.example.test"]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(await readMeta(dir), {
      version: 1,
      project_id: "legacy-id",
      backend: { type: "remote", url: "https://old.example.test/", protocol: "v2" },
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("link requires replace to change a remote origin", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({
      version: 1,
      project_id: "kept-id",
      backend: { type: "remote", url: "https://old.example.test/", protocol: "v2" },
    }, null, 2) + "\n");

    let result = await runLink(dir, ["https://new.example.test"]);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /LINK_REPLACE_REQUIRED/);
    assert.equal((await readMeta(dir)).backend.url, "https://old.example.test/");

    result = await runLink(dir, ["https://new.example.test", "--replace=true"]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(await readMeta(dir), {
      version: 1,
      project_id: "kept-id",
      backend: { type: "remote", url: "https://new.example.test/", protocol: "v2" },
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("link only changes project metadata and leaves local state bytes untouched", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({ version: 1, project_id: "kept-id" }, null, 2) + "\n");
    await writeCanonicalState(dir, { nodes: {}, edges: [], initiatives: {}, log: [] });
    const stateFile = stateFilePath(dir);
    const before = await fs.readFile(stateFile, "utf8");

    const result = await runLink(dir, ["https://climier.example.test"]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(await fs.readFile(stateFile, "utf8"), before);
  } finally {
    await rmTempProject(dir);
  }
});
