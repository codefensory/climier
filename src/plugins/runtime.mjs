// plugin-runtime.mjs: parse --project and --as from argv to build api.runtime.
//
// The V1 host (see ADR-005 §"API y persistencia" + §"Dispatch y contrato de
// errores") resolves --project and --as for itself before invoking the
// plugin handler. The dispatch layer uses this parser to materialise
// { project_dir, agent }.
//
//   resolveRuntime(argv) -> { project_dir, agent }
//
// Resolution rules:
//   - project_dir = --project (resolved) | process.cwd() when --project is missing.
//   - agent       = --as flag | CLIMIER_AGENT env var | "" (caller decides
//                   whether an empty agent is acceptable; data.*.set throws
//                   MISSING_AGENT when the agent is empty).
//
// argv is the post-dispatch token list (everything after the namespace and
// subcommand). The function does not mutate argv. Boolean true (a value
// flag with no following token) is treated as "missing" so an accidental
// `climier plugin ns sub --as` (no value) does not silently resolve agent
// from the env var.

import { resolveProject } from "../storage/paths.mjs";

// V1 flags whose values we want to extract. Other flags are ignored by
// this module (the dispatch forwards them unchanged to the handler).
const VALUE_FLAGS = new Set(["project", "as"]);

export function parseFlags(argv) {
  const flags = {};
  if (!Array.isArray(argv)) return flags;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== "string") continue;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    let key, val;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key) && typeof next === "string" && !next.startsWith("--")) {
        val = next;
        i++;
      } else {
        // Boolean-true path: --as alone is not a value. Treat as missing.
        val = true;
      }
    }
    flags[key] = val;
  }
  return flags;
}

export function resolveRuntime(argv) {
  const flags = parseFlags(argv);
  const projectFlag = flags.project;
  const projectInput = typeof projectFlag === "string" && projectFlag !== "" ? projectFlag : undefined;
  const project_dir = resolveProject({ project: projectInput });
  const asFlag = flags.as;
  const fromFlag = typeof asFlag === "string" ? asFlag.trim() : "";
  const fromEnv = typeof process.env.CLIMIER_AGENT === "string" ? process.env.CLIMIER_AGENT.trim() : "";
  const agent = fromFlag || fromEnv;
  return { project_dir, agent };
}
