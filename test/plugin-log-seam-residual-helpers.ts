import { importFresh } from "./helpers.ts";

type SubmitOptions = { as?: string; note?: string; pluginId?: string };

export async function submitAcceptTask(dir, id, options: SubmitOptions = {}) {
  const { as = "alice", note = "done", pluginId } = options;
  const { default: submit } = await importFresh("./cli/commands/submit.ts");
  const { default: accept } = await importFresh("./cli/commands/accept.ts");
  await submit({ statePath: dir, projectDir: dir, flags: { as, note }, positional: [id], pluginId });
  return accept({ statePath: dir, projectDir: dir, flags: { as }, positional: [id], pluginId });
}

export async function initProject(dir, initiatives = ["plugin-platform"]) {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
  for (const name of initiatives) {
    await addInit({ statePath: dir, flags: { desc: name }, positional: [name] });
  }
}

export async function seedOpenTask(dir, id, { initiative = "plugin-platform", status = "open" } = {}) {
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  await addNode({ statePath: dir, positional: [id], flags: { kind: "resolvable", subkind: "task", title: id, initiative, status } });
}

export function lastLog(state) {
  return state.log[state.log.length - 1];
}

export async function addTaskPair(dir, addTask) {
  for (const [id, pluginId] of [["T-cli", undefined], ["T-plugin", "example.audit"]]) {
    await addTask({
      statePath: dir,
      flags: { as: "alice", initiative: "plugin-platform", title: id, body: "b", acceptance: "a", "blocked-by": "" },
      positional: [id],
      projectDir: dir,
      ...(pluginId ? { pluginId } : {}),
    });
  }
}

export async function runLoggedHandlers(dir) {
  const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
  const { default: take } = await importFresh("./cli/commands/take.ts");
  const { default: addNote } = await importFresh("./cli/commands/add-note.ts");
  await addEdge({ statePath: dir, flags: { as: "alice", type: "BLOCKS" }, positional: ["T-flow", "T-flow-2"], pluginId: "example.audit" });
  await take({ statePath: dir, flags: { as: "alice" }, positional: ["T-flow"], projectDir: dir, pluginId: "example.audit" });
  await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T-flow", "ctx"], pluginId: "example.audit" });
}
