import { test } from "node:test";
import {
  createTempProject,
  rmTempProject,
  initProject,
  makeApi,
  readState,
  taskInput,
  assertParallelCreates,
  assertParallelLogs,
} from "./plugin-core-integration-helpers.mjs";

test("plugin-core-integration: two plugins calling core.run in parallel land both writes intact", async () => {
  const dir = await createTempProject();
  try {
    await initProject(dir);
    const revisionBefore = (await readState(dir)).revision;
    const apiA = await makeApi(dir, { agent: "alice", pluginId: "example.plugin-a" });
    const apiB = await makeApi(dir, { agent: "bob", pluginId: "example.plugin-b" });
    const [outA, outB] = await Promise.all([
      apiA.core.run({ op: "task.create", input: taskInput("T-A", "A") }),
      apiB.core.run({ op: "task.create", input: taskInput("T-B", "B") }),
    ]);
    assertParallelCreates(outA, outB, revisionBefore);
    const after = await readState(dir);
    assertParallelLogs(after);
  } finally {
    await rmTempProject(dir);
  }
});
