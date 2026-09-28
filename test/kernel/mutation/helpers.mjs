// Shared fixtures for the kernel mutation contract suites.
import { importFresh, writeCanonicalState } from "../../helpers.mjs";

// importKernel — helper that imports the kernel module fresh and pulls
// both `mutate` and `__kernelInternals` from the named export. Mutate is
// exported by name, not as default; helpers.mjs's importFresh returns
// the module's namespace, so we destructure `mutate` directly.
export async function importKernel() {
  return importFresh("./kernel/mutate.mjs");
}

// ===================================================================
// Fixture providers
// ===================================================================

// createTaskProvider — composes a brand-new node + edges in one apply.
export function createTaskProvider({ id, kind = "resolvable", subkind = "task", title, _revisionAfter = 1, edges = [], fields = {} } = {}) {
  return {
    prepare: async () => {
      return {
        target: { id, kind, subkind },
        policyAction: null,
        idempotent: false,
        // The plan carries enough information for apply to compose
        // without re-reading the snapshot.
        edges,
      };
    },
    apply: async ({ tx, plan }) => {
      tx.createNode({
        id: plan.target.id,
        kind: plan.target.kind,
        subkind: plan.target.subkind,
        title,
        status: "open",
        ...fields,
      });
      for (const edge of plan.edges || []) {
        tx.addEdge(edge);
      }
      return {
        result: { id: plan.target.id, kind: plan.target.kind, subkind: plan.target.subkind },
        effects: { newly_ready: [plan.target.id] },
      };
    },
  };
}

// updateNodeProvider — updates an existing node's title.
export function updateNodeProvider({ id, newTitle, _newRevision }) {
  let prepareCalls = 0;
  let applyCalls = 0;
  const provider = {
    prepare: async ({ snapshot }) => {
      prepareCalls += 1;
      const node = snapshot.nodes[id];
      if (!node) {
        const err = new Error("updateNodeProvider: target missing");
        err.code = "NODE_NOT_FOUND";
        throw err;
      }
      return {
        target: { id, kind: node.kind, subkind: node.subkind, status: node.status, revision: node.revision },
        policyAction: null,
        idempotent: false,
        newTitle,
      };
    },
    apply: async ({ tx, plan }) => {
      applyCalls += 1;
      tx.updateNode(plan.target.id, { title: plan.newTitle });
      return { result: { id: plan.target.id, title: plan.newTitle }, effects: null };
    },
  };
  return { provider, count: () => ({ prepare: prepareCalls, apply: applyCalls }) };
}

// ===================================================================
// Base state fixture
// ===================================================================

function applyFixtureMutation(base, mutate) {
  if (typeof mutate === "function") {
    mutate(base);
  }
}

export async function bootstrapProject(dir, mutate) {
  const base = {
    version: 1,
    nodes: {
      G1: {
        id: "G1",
        kind: "resolvable",
        subkind: "gate",
        title: "Gate 1",
        initiative: "kernel",
        status: "open",
        revision: 1,
      },
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "Original task title",
        initiative: "kernel",
        status: "open",
        revision: 2,
      },
    },
    edges: [
      { from: "G1", to: "T1", type: "BLOCKS" },
    ],
    initiatives: { kernel: { desc: "kernel", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
  applyFixtureMutation(base, mutate);
  return writeCanonicalState(dir, base);
}
