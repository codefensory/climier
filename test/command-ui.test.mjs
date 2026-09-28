import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import uiCommand, { assertUiSubproject } from "../src/cli/commands/ui.mjs";

test("ui subproject detection gives an actionable experimental feature error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-ui-detection-"));
  assert.throws(
    () => assertUiSubproject(root),
    (error) => {
      assert.equal(error.code, "UI_SUBPROJECT_MISSING");
      assert.match(error.message, /experimental UI is unavailable/);
      assert.match(error.message, /npm install/);
      assert.deepEqual(error.details.missing, ["ui/server/server.mjs", "ui/node_modules/express"]);
      return true;
    },
  );
});

test("ui reads state before optional UI code and preserves a corrupt-state error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-ui-state-"));
  const home = path.join(root, "home");
  await fs.writeFile(path.join(root, ".climier.json"), `${JSON.stringify({ version: 1, project_id: "ui-state-project" })}\n`);
  await fs.mkdir(path.join(home, "projects", "ui-state-project"), { recursive: true });
  await fs.writeFile(path.join(home, "projects", "ui-state-project", "tasks.json"), "not-json\n");
  const oldHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = home;
  try {
    await assert.rejects(
      uiCommand({ projectDir: root, flags: { open: false } }),
      (error) => error.code === "CLIMIER_CORRUPT_STATE",
    );
  } finally {
    if (oldHome === undefined) {delete process.env.CLIMIER_HOME;}
    else {process.env.CLIMIER_HOME = oldHome;}
  }
});

test("ui subproject detection accepts the server entry and express dependency", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-ui-detection-"));
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "express"), { recursive: true });
  await fs.writeFile(path.join(root, "server", "server.mjs"), "export {};\n");
  assert.doesNotThrow(() => assertUiSubproject(root));
});
