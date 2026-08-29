// T-plugin-core-e2e — V2 plugin fixture (ADR-006).
//
// Self-contained ESM module installed at runtime via `climier install
// ./test/fixtures/core-plugin`. Each subcommand below exercises one
// slice of the api.core surface end-to-end against the real core
// handlers in src/commands/*:
//
//   happy        task.create → edge.add → task.take → task.resolve →
//                note.add (full first slice).
//   partial      task.create (succeeds) → edge.add with a non-existent
//                target (fails). Demonstrates that the host does not
//                roll back the successful step.
//   invalid-op   core.run({ op: "edge.unknown", input }) returns
//                PLUGIN_CORE_INVALID_OPERATION without mutating state.
//   not-found    core.run({ op: "task.take", input: { id: "T-bogus" } })
//                returns PLUGIN_CORE_ACTION_FAILED with cause.code =
//                NODE_NOT_FOUND without mutating state.
//   multi        Spawn several task.create calls back-to-back so the
//                concurrency test can interleave them with CLI writes.
//
// The module has zero runtime dependencies: no npm packages are pulled
// when the fixture is installed, keeping tests offline-friendly
// (ADR-006 plan §8 risk #4). All logic is plain ESM.

function parseArgs(tokens) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t !== "string" || !t) continue;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq !== -1) {
        flags[t.slice(2, eq)] = t.slice(eq + 1);
      } else {
        const key = t.slice(2);
        const next = tokens[i + 1];
        if (next !== undefined && !String(next).startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(t);
    }
  }
  return { flags, positional };
}

// requirePositional: shared helper that converts a missing positional
// into a structured PLUGIN_HANDLER_FAILED so the bin emits a clear
// envelope instead of an opaque throw.
function requirePositional(positional, idx, name) {
  const v = positional[idx];
  if (typeof v !== "string" || !v) {
    const e = new Error(`core: ${name} required`);
    e.code = "PLUGIN_HANDLER_FAILED";
    e.details = { missing: name };
    throw e;
  }
  return v;
}

// envelope — turn a caught PLUGIN_CORE_* error into a JSON envelope the
// test can assert against without re-reading the state file.
function envelopeFor(err) {
  return {
    ok: false,
    code: err && err.code,
    message: err && err.message,
    details: err && err.details,
  };
}

// nodeRevision — read the canonical node revision from a typed
// api.core.run result. Mutation inputs use this value as their CAS
// precondition instead of relying on a legacy `{ node }` envelope or a
// hard-coded revision.
function nodeRevision(output, id, changeKind) {
  const change = output?.diff?.[changeKind]?.find((entry) => entry.id === id);
  const revision = change?.node?.revision;
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error(`core fixture: ${changeKind} result missing revision for '${id}'`);
  }
  return revision;
}

export default {
  commands: {
    // happy: full first slice (ADR-006 §"API y compatibilidad"). The
    // returned object surfaces each typed api.core.run result so
    // test/plugin-core-e2e can assert the public contract without
    // touching internals.
    async happy(_args, api) {
      const create1 = await api.core.run({
        op: "task.create",
        input: {
          id: "T-core-happy-1",
          initiative: "core-e2e",
          title: "happy task 1",
          body: "first task",
          acceptance: "a",
          blocked_by: "",
        },
      });
      const create2 = await api.core.run({
        op: "task.create",
        input: {
          id: "T-core-happy-2",
          initiative: "core-e2e",
          title: "happy task 2",
          body: "second task",
          acceptance: "a",
          blocked_by: "",
        },
      });
      const edge = await api.core.run({
        op: "edge.add",
        input: { from: "T-core-happy-1", to: "T-core-happy-2", type: "BLOCKS" },
      });
      const taken = await api.core.run({
        op: "task.take",
        input: {
          id: "T-core-happy-1",
          if_revision: nodeRevision(create1, "T-core-happy-1", "created"),
        },
      });
      const resolved = await api.core.run({
        op: "task.resolve",
        input: {
          id: "T-core-happy-1",
          note: "happy: shipped via core.run",
          if_revision: nodeRevision(taken, "T-core-happy-1", "updated"),
        },
      });
      const noted = await api.core.run({
        op: "note.add",
        input: {
          id: "T-core-happy-2",
          text: "happy: ctx note via core.run",
          if_revision: nodeRevision(create2, "T-core-happy-2", "created"),
        },
      });
      return {
        command: "happy",
        create1,
        create2,
        edge,
        taken,
        resolved,
        noted,
      };
    },

    // partial: ADR-006 §"Secuencias parciales" — a successful step
    // survives when a follow-up step rejects. The fixture returns the
    // typed create result and the rejection envelope so the test can
    // verify the survival + the cause.code without re-reading state.
    async partial(_args, api) {
      const create = await api.core.run({
        op: "task.create",
        input: {
          id: "T-core-partial-1",
          initiative: "core-e2e",
          title: "partial task",
          body: "first step should survive",
          acceptance: "a",
          blocked_by: "",
        },
      });
      let rejected = null;
      try {
        await api.core.run({
          op: "edge.add",
          input: {
            from: "T-core-partial-1",
            to: "T-core-partial-DOES-NOT-EXIST",
            type: "BLOCKS",
          },
        });
      } catch (err) {
        rejected = envelopeFor(err);
      }
      return { command: "partial", create, rejected };
    },

    // invalid-op: PLUGIN_CORE_INVALID_OPERATION is rejected before any
    // state mutation. The fixture does NOT touch the handler envelope
    // here; it just relays the rejection. The test asserts on the
    // envelope shape (code, details.op, details.reason, details.supported)
    // and on the post-call state being untouched.
    async invalidop(_args, api) {
      let rejected = null;
      try {
        await api.core.run({
          op: "edge.unknown",
          input: { from: "x", to: "y", type: "BLOCKS" },
        });
      } catch (err) {
        rejected = envelopeFor(err);
      }
      return { command: "invalidop", rejected };
    },

    // not-found: handler-rejected action surfaces as
    // PLUGIN_CORE_ACTION_FAILED with a structured cause. The fixture
    // exercises task.take against a missing id (throwV2 NODE_NOT_FOUND)
    // because it is the cheapest mutation-free rejection path. The
    // returned envelope lets the test assert cause.code == NODE_NOT_FOUND
    // and the post-call state being intact.
    async notfound(_args, api) {
      let rejected = null;
      try {
        await api.core.run({
          op: "task.take",
          input: { id: "T-core-bogus-not-found" },
        });
      } catch (err) {
        rejected = envelopeFor(err);
      }
      return { command: "notfound", rejected };
    },

    // multi: a small loop of task.create calls used by the concurrency
    // test (T-plugin-core-e2e §3). The number is taken from the first
    // positional so the test can tune the burst; default = 3.
    async multi(args, api) {
      const { positional } = parseArgs(args);
      const count = Math.max(
        1,
        Math.min(50, parseInt(positional[0] || "3", 10) || 3),
      );
      const out = [];
      for (let i = 0; i < count; i++) {
        const id = `T-core-multi-${i}-${Date.now().toString(36)}`;
        const created = await api.core.run({
          op: "task.create",
          input: {
            id,
            initiative: "core-e2e",
            title: `multi ${i}`,
            body: "b",
            acceptance: "a",
            blocked_by: "",
          },
        });
        const taken = await api.core.run({
          op: "task.take",
          input: { id, if_revision: nodeRevision(created, id, "created") },
        });
        out.push({ id, created, taken });
      }
      return { command: "multi", count, created: out.map((o) => o.id) };
    },
  },
};
