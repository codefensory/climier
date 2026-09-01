// plugins/api.mjs: assemble the host API surface.
//
// Per ADR-005 §"API y persistencia" + ADR-006 §"API y compatibilidad":
//   api = {
//     runtime: { project_dir, agent },
//     query:   { node, context, status, history },
//     data:    { node: { get, set }, project: { get, set } },
//     core:    { version: 2, run({ op, input }), batch({ if_state_revision, operations }) },
//   }
//
// The dispatch layer invokes createApi({ projectDir, agent, pluginId })
// once per plugin invocation. The handler receives `api` and uses it.
//
// V1 constraints enforced here:
//   - projectDir and pluginId are required non-empty strings.
//   - agent may be the empty string (anonymous dispatch is not a V1
//     invariant), but data.*.set will throw MISSING_AGENT when it is.
//   - api.runtime is a literal projection of the resolved identity; no
//     mutation, no I/O. It exists so handlers can read project_dir and
//     agent without touching argv or env vars themselves.
//
// api.core is the host surface for individual core actions. It is created
// unconditionally — V1 hosts may call `api.core?.version`, while the host
// defined by ADR-006 always imports this adapter. runtime.agent is captured
// into the core surface so `core.run` can fix flags.as on every call
// regardless of what the plugin passes in input.

import { createQuery } from "./query.mjs";
import { createData } from "./data.mjs";
import { createCore } from "./core-adapter.mjs";

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
  const query = createQuery({ projectDir, agent: runtime.agent, pluginId });
  const data = createData({ projectDir, agent: runtime.agent, pluginId });
  const core = createCore({
    projectDir,
    agent: runtime.agent,
    pluginId,
  });
  return { runtime, query, data, core };
}
