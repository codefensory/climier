// next: end-to-end with the migration seed (F1.T1 must surface the db gotcha if applicable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli } from "./helpers.mjs";

test("CLI: next F1.T1 returns title, acceptance, gotchas after seed", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--seed", "migration"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "next", "F1.T1"]);
    assert.equal(r.code, 0, r.stderr);
    // F1.T1 is the monorepo skeleton, domain:monorepo
    assert.match(r.stdout, /F1\.T1/);
  } finally {
    await rmTempProject(dir);
  }
});
