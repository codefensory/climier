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

test("remote metadata with any protocol marker fails before local state access and shows the cleanup URL", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({
      version: 1,
      project_id: "legacy-id",
      backend: { type: "remote", protocol: "v2", url: "https://old.example.test/base" },
    }, null, 2) + "\n");

    for (const args of [["status"], ["context", "T1"], ["push", "--as", "alice"]]) {
      const result = await runCli(["--project", dir, ...args]);
      assert.equal(result.code, 1, result.stdout);
      const out = JSON.parse(result.stdout);
      assert.equal(out.error.code, "REMOTE_CONFIG_OUTDATED");
      assert.match(out.error.message, /https:\/\/old\.example\.test\/base/);
      assert.match(out.error.message, /climier link https:\/\/old\.example\.test\/base/);
    }
    await assert.rejects(fs.access(stateFilePath(dir)), { code: "ENOENT" });
  } finally {
    await rmTempProject(dir);
  }
});

test("link writes remote metadata without a protocol marker and generates an id when metadata is missing", async () => {
  const dir = await createTempProject();
  try {
    const result = await runLink(dir, ["https://climier.example.test"]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      project: {
        project_id: (await readMeta(dir)).project_id,
        backend: { type: "remote", url: "https://climier.example.test/" },
      },
    });
    const meta = await readMeta(dir);
    assert.equal(meta.version, 1);
    assert.match(meta.project_id, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(meta.backend, { type: "remote", url: "https://climier.example.test/" });
  } finally {
    await rmTempProject(dir);
  }
});

test("link stores only public metadata for a remote HTTP origin without an opt-in", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({ version: 1, project_id: "kept-id" }, null, 2) + "\n");
    const result = await runLink(dir, ["http://remote.example.test:43127"]);
    assert.equal(result.code, 0, result.stdout);
    const publicBackend = { type: "remote", url: "http://remote.example.test:43127/" };
    assert.deepEqual(JSON.parse(result.stdout).project.backend, publicBackend);
    assert.deepEqual((await readMeta(dir)).backend, publicBackend);
  } finally {
    await rmTempProject(dir);
  }
});

test("link preserves the existing project id and is idempotent for the same normalized URL", async () => {
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

test("link relinks old metadata-only state without backend access and preserves unrelated metadata", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({
      version: 1,
      project_id: "legacy-id",
      label: "keep me",
      backend: { type: "remote", protocol: "v2", url: "https://old.example.test/" },
    }, null, 2) + "\n");

    const result = await runLink(dir, ["https://old.example.test"]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(await readMeta(dir), {
      version: 1,
      project_id: "legacy-id",
      label: "keep me",
      backend: { type: "remote", url: "https://old.example.test/" },
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("link requires replace to change a remote URL", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({
      version: 1,
      project_id: "kept-id",
      backend: { type: "remote", url: "https://old.example.test/" },
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
      backend: { type: "remote", url: "https://new.example.test/" },
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
