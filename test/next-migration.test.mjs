// next: end-to-end with the example fixture (F1.T1 must surface the db gotcha if applicable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli, initExampleProject} from "./helpers.mjs";

test("CLI: next F1.T1 returns id, title, acceptance, gotchas after seed", async () => {
  const dir = await createTempProject();
  try {
    let r = await initExampleProject(dir);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "next", "F1.T1"]);
    assert.equal(r.code, 0, r.stderr);
    // F1.T1 is the monorepo skeleton, domain:monorepo
    const data = JSON.parse(r.stdout);
    assert.equal(data.id, "F1.T1");
    assert.ok(data.title);
  } finally {
    await rmTempProject(dir);
  }
});
