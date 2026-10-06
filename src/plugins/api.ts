
import { createQuery } from "./query.ts";
import { createData } from "./data.ts";
import { createCore } from "./core-adapter.ts";
import { createRuntime } from "./runtime.ts";
import { assertLocalBackend } from "./remote-guard.ts";

export function createApi({ projectDir, agent, pluginId, backendClient }) {
  assertLocalBackend(backendClient, "createApi");
  if (typeof projectDir !== "string" || !projectDir) {
    throw new Error("createApi: projectDir required");
  }
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createApi: pluginId required");
  }
  const runtime = createRuntime({ projectDir, agent, pluginId, backendClient });
  const query = createQuery({ projectDir, agent: runtime.agent, pluginId, backendClient });
  const data = createData({ projectDir, agent: runtime.agent, pluginId, backendClient });
  const core = createCore({
    projectDir,
    agent: runtime.agent,
    pluginId,
    backendClient,
  });
  return { version: 1, runtime, query, data, core };
}
