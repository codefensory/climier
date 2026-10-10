import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isValidProjectName, normalizeProjectName } from "../src/contracts/project-name.ts";
import { readProjectName, writeProjectName } from "../src/storage/state.ts";
import { createTempProject, rmTempProject, runCli } from "./helpers.ts";

type Meta = { version: number; project_id: string; name?: string };

async function makeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-project-name-home-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });
  return home;
}

async function makeCheckout(t, basename = "climier-named-project") {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "climier-project-name-"));
  const dir = path.join(parent, basename);
  await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return dir;
}

async function readMeta(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8")) as Meta;
}

test("project name normalization collapses whitespace, drops blanks, and caps length", () => {
  assert.equal(normalizeProjectName("  Mi   Proyecto  "), "Mi Proyecto");
  assert.equal(normalizeProjectName(""), null);
  assert.equal(normalizeProjectName("   "), null);
  assert.equal(normalizeProjectName(42), null);
  assert.equal(isValidProjectName("ok"), true);
  assert.equal(isValidProjectName("   "), false);
  assert.equal(isValidProjectName("x".repeat(121)), false);
  assert.equal(isValidProjectName("x".repeat(120)), true);
});

test("writeProjectName/readProjectName round-trip and reject a foreign id", async (t) => {
  const home = await makeHome(t);

  await writeProjectName("proj-a", "  Alpha  ");
  assert.equal(await readProjectName("proj-a"), "Alpha");
  assert.equal(await readProjectName("missing"), null);

  await fs.mkdir(path.join(home, "projects", "proj-b"), { recursive: true });
  await fs.writeFile(
    path.join(home, "projects", "proj-b", "project.json"),
    JSON.stringify({ version: 1, project_id: "someone-else", name: "Wrong" }),
  );
  assert.equal(await readProjectName("proj-b"), null);
  await assert.rejects(writeProjectName("proj-a", "   "), /non-empty/);
});

test("init names the project after its checkout directory", async (t) => {
  await makeHome(t);
  const dir = await makeCheckout(t, "climier-named-project");

  const init = await runCli(["--project", dir, "init"]);
  assert.equal(init.code, 0, init.stdout);

  const meta = await readMeta(dir);
  assert.equal(meta.name, undefined, "init stays minimal; the name is explicit metadata only");
  assert.equal(await readProjectName(meta.project_id), "climier-named-project");
});

test("every command backfills the display name without rewriting .climier.json", async (t) => {
  await makeHome(t);
  const dir = await makeCheckout(t, "backfill-project");
  await fs.writeFile(path.join(dir, ".climier.json"), `${JSON.stringify({ version: 1, project_id: "fixed-id" })}\n`);

  const status = await runCli(["--project", dir, "status"]);
  assert.equal(status.code, 0, status.stdout);
  assert.equal(await readProjectName("fixed-id"), "backfill-project");
  assert.deepEqual(await readMeta(dir), { version: 1, project_id: "fixed-id" });
});

test("an explicit metadata name wins over the directory name", async (t) => {
  await makeHome(t);
  const dir = await makeCheckout(t, "dir-name");
  await fs.writeFile(path.join(dir, ".climier.json"), `${JSON.stringify({ version: 1, project_id: "fixed-id", name: "Nombre Elegido" })}\n`);

  const status = await runCli(["--project", dir, "status"]);
  assert.equal(status.code, 0, status.stdout);
  assert.equal(await readProjectName("fixed-id"), "Nombre Elegido");
});

test("climier rename sets the explicit name in metadata and in the state sidecar", async (t) => {
  await makeHome(t);
  const dir = await makeCheckout(t, "rename-project");
  await runCli(["--project", dir, "init"]);

  const renamed = await runCli(["--project", dir, "rename", "  Plataforma   Interna  "]);
  assert.equal(renamed.code, 0, renamed.stdout);
  const meta = await readMeta(dir);
  assert.deepEqual(JSON.parse(renamed.stdout), { project: { project_id: meta.project_id, name: "Plataforma Interna" } });
  assert.equal(meta.name, "Plataforma Interna");
  assert.equal(await readProjectName(meta.project_id), "Plataforma Interna");
});

test("climier rename rejects missing or invalid input and missing metadata", async (t) => {
  await makeHome(t);
  const dir = await makeCheckout(t, "rename-errors");

  const missing = await runCli(["--project", dir, "rename"]);
  assert.equal(missing.code, 2);
  assert.equal((JSON.parse(missing.stdout) as { error: { code: string } }).error.code, "CLI_USAGE_ERROR");

  const blank = await runCli(["--project", dir, "rename", "   "]);
  assert.equal(blank.code, 2);
  assert.equal((JSON.parse(blank.stdout) as { error: { code: string } }).error.code, "CLI_USAGE_ERROR");

  const tooLong = await runCli(["--project", dir, "rename", "x".repeat(121)]);
  assert.equal(tooLong.code, 2);
  assert.equal((JSON.parse(tooLong.stdout) as { error: { code: string } }).error.code, "CLI_USAGE_ERROR");

  const uninitialized = await runCli(["--project", dir, "rename", "Late"]);
  assert.equal(uninitialized.code, 1);
  assert.equal((JSON.parse(uninitialized.stdout) as { error: { code: string } }).error.code, "CLIMIER_PROJECT_META_MISSING");
});

test("climier link --name records the explicit name", async (t) => {
  await makeHome(t);
  const dir = await makeCheckout(t, "linked-project");

  const linked = await runCli(["--project", dir, "link", "https://climier.example.test", "--name", "Linked"]);
  assert.equal(linked.code, 0, linked.stdout);
  const meta = await readMeta(dir);
  assert.equal(meta.name, "Linked");
  assert.equal(await readProjectName(meta.project_id), "Linked");
});
