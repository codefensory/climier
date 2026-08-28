// T-plugin-policy-fixture — V2-policy fixture.
//
// Reusable plugin entry that exercises the policy contract from
// ADR-007 §"Discovery global" and §"Contrato de autorización".
// The fixture has zero runtime dependencies so `climier install
// ./test/fixtures/plugins/policy-fixture` works offline
// (mirrors ADR-006 plan §8 risk #4 for the V2 fixtures).
//
//   default.commands
//     applies-check        Reports what applies(projectConfig) returns
//                        given the current .climier.json (read raw by
//                        the subcommand; the foundation's
//                        readProjectConfig will do the same).
//     authorize-check <action>
//                        Synthesizes a policy context and reports
//                        what authorize returns (or throws) and
//                        which actor/action/target/projectConfig
//                        it received. The projectConfig is frozen
//                        before being passed, mirroring what the
//                        foundation will do per plan §3.3.
//     recorded            Returns the last invocation recorded by
//                        authorize. Downstream tests use this to
//                        audit what the seam actually passed.
//
//   default.policy
//     applies(projectConfig)
//                        Returns false ONLY when the namespace
//                        plugins["policy-fixture"].applies === false.
//                        Otherwise returns true (covers explicit true,
//                        undefined, and missing namespace).
//     authorize(ctx)
//                        Reads mode from the namespace
//                        plugins["policy-fixture"].mode:
//                          allow   -> { decision: "allow" }
//                          deny    -> { decision: "deny", reason }
//                          abstain -> { decision: "abstain" }
//                          slow    -> sleep
//                                      plugins["policy-fixture"].slowMs
//                                      (default 50), then
//                                      { decision: "allow" }
//                          throw   -> throws POLICY_ERROR_FIXTURE
//                        Each invocation is recorded under
//                        CLIMIER_HOME/policy-fixture-state.json so
//                        downstream tests can audit what the seam
//                        observed without re-reading .climier.json.
//
// The plugin only reads its own namespace (`plugins["policy-fixture"]`)
// per ADR-007 §"Discovery global": "El plugin solo lee su propio
// namespace". Other plugins' namespaces do not affect applies/authorize.

import fs from "node:fs/promises";
import path from "node:path";

const PLUGIN_ID = "policy-fixture";

// parseArgs: split forwarded tokens into {flags, positional}. Mirrors
// the host's bin parser so the fixture can pick the first positional
// even when the user forwarded flags like `--project`/`--as`. Boolean
// flags (`--all`, `--force`, `--no-color`) are treated as no-value;
// everything else consumes the next token when present.
function parseArgs(tokens) {
  const flags = {};
  const positional = [];
  const BOOLEAN_FLAGS = new Set(["all", "force", "no-color"]);
  if (!Array.isArray(tokens)) return { flags, positional };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t !== "string" || !t) continue;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      let key, val;
      if (eq !== -1) {
        key = t.slice(2, eq);
        val = t.slice(eq + 1);
      } else {
        key = t.slice(2);
        const isBool = BOOLEAN_FLAGS.has(key);
        const next = tokens[i + 1];
        if (!isBool && typeof next === "string" && !next.startsWith("--")) {
          val = next;
          i++;
        } else {
          val = true;
        }
      }
      flags[key] = val;
    } else {
      positional.push(t);
    }
  }
  return { flags, positional };
}

// readRawConfig: read .climier.json from projectDir; return {} when
// missing. Mirrors what the foundation's readProjectConfig will do so
// the subcommand tests exercise the same contract.
async function readRawConfig(projectDir) {
  const metaPath = path.join(projectDir, ".climier.json");
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw err;
  }
}

// applyNamespace: returns the policy-fixture namespace entry from
// the raw projectConfig, or null when missing. Defensive: non-object
// configs or non-object namespaces return null rather than throwing,
// so a malformed harness cannot take down the test.
function applyNamespace(projectConfig) {
  if (!projectConfig || typeof projectConfig !== "object") return null;
  const plugins = projectConfig.plugins;
  if (!plugins || typeof plugins !== "object") return null;
  const ns = plugins[PLUGIN_ID];
  if (!ns || typeof ns !== "object") return null;
  return ns;
}

// recordLast: persist the last authorize invocation to
// CLIMIER_HOME/policy-fixture-state.json. Captures scalar metadata
// only; never clones or mutates ctx (the host passes a frozen
// projectConfig — copying it could mask bugs). Best-effort: a
// recording failure must not mask the actual decision.
async function recordLast(ctx, mode) {
  const home = process.env.CLIMIER_HOME;
  if (!home) return;
  const stateFile = path.join(home, "policy-fixture-state.json");
  const ns = applyNamespace(ctx && ctx.projectConfig);
  const recorded = {
    ts: new Date().toISOString(),
    mode,
    received: {
      action: ctx && typeof ctx.action === "string" ? ctx.action : null,
      actor: ctx && typeof ctx.actor === "string" ? ctx.actor : null,
      target: ctx && ctx.target && typeof ctx.target === "object"
        ? {
            id: typeof ctx.target.id === "string" ? ctx.target.id : null,
            kind: typeof ctx.target.kind === "string" ? ctx.target.kind : null,
            subkind: typeof ctx.target.subkind === "string" ? ctx.target.subkind : null,
          }
        : null,
      projectDir: ctx && typeof ctx.projectDir === "string" ? ctx.projectDir : null,
      snapshot_keys:
        ctx && ctx.snapshot && typeof ctx.snapshot === "object"
          ? Object.keys(ctx.snapshot)
          : null,
      projectConfig_frozen:
        ctx && ctx.projectConfig ? Object.isFrozen(ctx.projectConfig) : null,
      projectConfig_keys:
        ctx && ctx.projectConfig && typeof ctx.projectConfig === "object"
          ? Object.keys(ctx.projectConfig)
          : null,
    },
    namespace_keys: ns ? Object.keys(ns) : null,
  };
  try {
    await fs.writeFile(stateFile, JSON.stringify(recorded, null, 2) + "\n", "utf8");
  } catch {
    // best-effort: never let the audit trail mask a decision.
  }
}

// applies: contract from ADR-007 §"Discovery global":
//   applies recibe una lectura raw de .climier.json; si el archivo
//   no existe, recibe {}.
//   El resultado de applies no se cachea entre comandos.
//
// Cobertura (deterministic, controllable via .climier.json namespace):
//   missing namespace                -> true (default applicable)
//   { applies: true }                -> true
//   { applies: false }               -> false
//   { applies: "true" (non-boolean) } -> true (strict boolean check)
//   malformed namespace (non-object) -> true (defensive)
export async function applies(projectConfig) {
  const ns = applyNamespace(projectConfig);
  if (ns === null) return true;
  if (ns.applies === true) return true;
  if (ns.applies === false) return false;
  return true;
}

// authorize: contract from ADR-007 §"Contrato de autorización":
//   returns exactly one of:
//     { decision: "allow" }
//     { decision: "deny", reason }
//     { decision: "abstain" }
//   or throws (mapped to POLICY_ERROR by the seam).
//
// Modes (driven by .climier.json plugins["policy-fixture"].mode):
//   allow | deny | abstain | throw | slow
//
// Slow mode sleeps ctx.projectConfig.plugins["policy-fixture"].slowMs
// (default 50ms) then returns { decision: "allow" }. The lock-holding
// concurrency tests verify the seam holds withLock throughout the
// sleep (ADR-008 §"Seam por handler").
export async function authorize(ctx) {
  const ns = applyNamespace(ctx && ctx.projectConfig);
  const mode = ns && typeof ns.mode === "string" ? ns.mode : "allow";

  // Record BEFORE deciding so a throw still leaves a trace.
  await recordLast(ctx || {}, mode);

  if (mode === "allow") return { decision: "allow" };

  if (mode === "deny") {
    const reason =
      ns && typeof ns.reason === "string" && ns.reason.trim()
        ? ns.reason
        : "denied by policy-fixture";
    return { decision: "deny", reason };
  }

  if (mode === "abstain") return { decision: "abstain" };

  if (mode === "slow") {
    const slowMs =
      ns && Number.isFinite(ns.slowMs) && ns.slowMs >= 0 ? ns.slowMs : 50;
    await new Promise((resolve) => setTimeout(resolve, slowMs));
    return { decision: "allow" };
  }

  if (mode === "throw") {
    const err = new Error("policy-fixture: mode 'throw' rejected the action");
    err.code = "POLICY_ERROR_FIXTURE";
    throw err;
  }

  // Unknown mode -> throw (mirrors what POLICY_ERROR expects from the
  // seam per ADR-007 §"Errores"). This is intentionally not "abstain"
  // so a typo in the harness surfaces immediately.
  const err = new Error(`policy-fixture: unknown mode '${mode}'`);
  err.code = "POLICY_ERROR_FIXTURE";
  throw err;
}

// Helper used by the authorize-check subcommand to mirror what the
// foundation's loadApplicablePolicy will do: read raw .climier.json
// and freeze the top-level object before passing it to applies /
// authorize. The freeze is shallow (matches plan §3.3) and the
// fixture never mutates the frozen object — it only reads.
function freezeProjectConfig(config) {
  const plugins = config.plugins
    ? {
        ...config.plugins,
        [PLUGIN_ID]: config.plugins[PLUGIN_ID] && typeof config.plugins[PLUGIN_ID] === "object"
          ? config.plugins[PLUGIN_ID]
          : {},
      }
    : { [PLUGIN_ID]: {} };
  return Object.freeze({
    ...config,
    plugins: Object.freeze(plugins),
  });
}

export default {
  commands: {
    // applies-check: directly invokes applies() against the raw
    // .climier.json read from disk. Returns the verdict plus a brief
    // config fingerprint so the test can assert on what the fixture
    // observed.
    async "applies-check"(_args, api) {
      const config = await readRawConfig(api.runtime.project_dir);
      const verdict = await applies(config);
      const ns = applyNamespace(config);
      return {
        command: "applies-check",
        applies: verdict,
        namespace_present: ns !== null,
        namespace_keys: ns ? Object.keys(ns) : null,
        config_keys: Object.keys(config),
      };
    },

    // authorize-check <action>: synthesizes a context and calls
    // authorize(); returns the decision (or error) and the
    // actor/action/target/projectConfig-keys the fixture received.
    // The freeze + snapshot shape mirror what the foundation will
    // pass so the fixture sees a contract-compatible input.
    async "authorize-check"(args, api) {
      const config = await readRawConfig(api.runtime.project_dir);
      const { positional } = parseArgs(args);
      const action = (positional[0] && typeof positional[0] === "string")
        ? positional[0]
        : "task.take";
      const actor = api.runtime.agent || "";
      const target = {
        id: "T-fixture-target",
        kind: "resolvable",
        subkind: "task",
      };
      const snapshot = {
        state: {},
        nodes: {
          "T-fixture-target": {
            id: "T-fixture-target",
            kind: "resolvable",
            subkind: "task",
            status: "open",
          },
        },
        edges: [],
        initiatives: {
          "policy-fixture-test": {
            desc: "policy-fixture test initiative",
            created_at: new Date().toISOString(),
          },
        },
      };
      const frozenConfig = freezeProjectConfig(config);
      const ctx = {
        action,
        actor,
        target,
        snapshot,
        projectDir: api.runtime.project_dir,
        projectConfig: frozenConfig,
      };
      // authorize's throw IS the policy's response for mode='throw' —
      // do not mask it. The dispatcher wraps it as PLUGIN_HANDLER_FAILED
      // with the cause chain preserving err.code (POLICY_ERROR_FIXTURE).
      const decision = await authorize(ctx);
      return {
        command: "authorize-check",
        received: {
          action,
          actor,
          target_id: target.id,
          target_kind: target.kind,
          snapshot_kind: snapshot && typeof snapshot,
          projectDir: api.runtime.project_dir,
          projectConfig_frozen: Object.isFrozen(frozenConfig),
          projectConfig_keys: Object.keys(frozenConfig),
          namespace_keys: applyNamespace(frozenConfig)
            ? Object.keys(applyNamespace(frozenConfig))
            : null,
        },
        decision,
      };
    },

    // recorded: returns the persisted last invocation written by
    // authorize. Useful for tests that want to audit what the seam
    // passed to the policy without re-reading .climier.json.
    async "recorded"(_args, _api) {
      const home = process.env.CLIMIER_HOME;
      if (!home) return { command: "recorded", recorded: null };
      const file = path.join(home, "policy-fixture-state.json");
      try {
        const raw = await fs.readFile(file, "utf8");
        return { command: "recorded", recorded: JSON.parse(raw) };
      } catch (err) {
        if (err && err.code === "ENOENT") return { command: "recorded", recorded: null };
        throw err;
      }
    },
  },

  policy: {
    applies,
    authorize,
  },
};