// plugin-api.mjs: assemble the V1 host API surface.
//
// Per ADR-005 §"API y persistencia":
//   api = {
//     runtime: { project_dir, agent },
//     query:   { node, context, status, history },
//     data:    { node: { get, set }, project: { get, set } },
//   }
//
// T-plugin-dispatch invokes createApi({ projectDir, agent, pluginId })
// once per plugin invocation. The handler receives `api` and uses it.
//
// V1 constraints enforced here:
//   - projectDir and pluginId are required non-empty strings.
//   - agent may be the empty string (anonymous dispatch is not a V1
//     invariant), but data.*.set will throw MISSING_AGENT when it is.
//   - api.runtime is a literal projection of the resolved identity; no
//     mutation, no I/O. It exists so handlers can read project_dir and
//     agent without touching argv or env vars themselves.

import { createQuery } from "./plugin-query.mjs";
import { createData } from "./plugin-data.mjs";

export function createApi({ projectDir, agent, pluginId }) {
  if (typeof projectDir !== "string" || !projectDir) {
    throw new Error("createApi: projectDir required");
  }
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createApi: pluginId required");
  }
  const runtime = {
    project_dir: projectDir,
    agent: typeof agent === "string" ? agent : "",
  };
  const query = createQuery({ projectDir, agent: runtime.agent });
  const data = createData({ projectDir, agent: runtime.agent, pluginId });
  return { runtime, query, data };
}
