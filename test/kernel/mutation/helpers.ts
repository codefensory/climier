// Shared fixtures for the kernel mutation contract suites.
import { importFresh, writeCanonicalState } from "../../helpers.ts";

// importKernel — helper that imports the kernel module fresh and pulls
// both `mutate` and `__kernelInternals` from the named export. Mutate is
// exported by name, not as default; helpers.ts's importFresh returns

export async function importKernel() {
  return importFresh("./kernel/mutate.ts");
}

// Fixture providers

type CreateTaskOptions = {
  id?: string;
  kind?: string;
  subkind?: string;
  title?: string;
  _revisionAfter?: number;
  edges?: Array<Record<string, unknown>>;
  fields?: Record<string, unknown>;
};
type UpdateNodeOptions = { id?: string; newTitle?: string; _newRevision?: number };
type FixtureState = {
  nodes: Record<string, Record<string, unknown>>;
  revision: number;
  log: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
type FixtureDraft = {
  nodes: Record<string, Record<string, unknown>>;
  revision?: number;
  log: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

// createTaskProvider — composes a brand-new node + edges in one apply.
export function createTaskProvider({ id, kind = "resolvable", subkind = "task", title, _revisionAfter = 1, edges = [], fields = {} }: CreateTaskOptions = {}) {
  return {
    prepare: async () => {
      return {
        target: { id, kind, subkind },
        policyAction: null,
        idempotent: false,

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
export function updateNodeProvider({ id, newTitle, _newRevision }: UpdateNodeOptions) {
  let prepareCalls = 0;
  let applyCalls = 0;
  const provider = {
    prepare: async ({ snapshot, ..._context }) => {
      prepareCalls += 1;
      const node = id === undefined ? undefined : snapshot.nodes[id];
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

// Base state fixture

function applyFixtureMutation(base: FixtureDraft, mutate: ((state: FixtureDraft) => void) | undefined): void {
  if (typeof mutate === "function") {
    mutate(base);
  }
}

export async function bootstrapProject(dir: string, mutate?: (state: FixtureDraft) => void): Promise<FixtureState> {
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
