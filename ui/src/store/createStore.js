// ui/src/store/createStore.js
//
// Builds the reactive store for the climier UI. The store is composed
// of five slices (transport, ui, entities, views, details) backed by
// `solid-js/store`. Snapshots are ingested via `normalizeSnapshot` and
// reconciled per slice so that entities, edges, initiatives and plugins
// keep stable references across polls when their content does not
// change. Detail extras live in their own slice so a poll that updates
// the base entity never replaces the detail entry.
//
// Public surface returned by `createReactiveStore()`:
//
//   store              reactive store proxy
//   actions.ingestSnapshot(snap)             apply a server snapshot
//   actions.ingestDetail(id, payload)        store extras for a node
//   actions.clearDetail(id)                  drop extras for a node
//   actions.clearAllDetails()                drop all extras
//   actions.setTransportInitialLoading(b)
//   actions.setTransportRefreshing(b)
//   actions.setTransportSnapshotError(msg|null)
//   actions.setTransportLastSuccessfulAt(iso|null)
//   actions.setTransportGeneratedAt(iso|null)
//   actions.setTransportReadAlerts(alerts)
//   actions.setUiRoute(route)
//   actions.setUiSelectedId(id|null)
//   actions.setUiDetailId(id|null)
//   actions.setUiDetail(payload|null)
//   actions.setUiDetailError(msg|null)
//   actions.selectors.tasksByStatus()
//   actions.selectors.openGates()
//   actions.selectors.nodesMap()
//
// See .adrs/010-ui-live-store.md §1 / §2 / §3 and
// docs/plans/ui-live-store-execution.md §3.2 / §3.3 / §3.5 / §11.3.

import { createStore as createSolidStore, reconcile } from "solid-js/store";

import { normalizeSnapshot } from "./normalize.js";
import {
  edgeKey,
  keyForInitiative,
  keyForPlugin,
  stableEdges,
  stableInitiatives,
  stableNodes,
  stablePlugins,
} from "./reconcile.js";
import { tasksByStatus, openGates, nodesMap } from "./selectors.js";
import { applyDetail, clearDetail, clearAllDetails } from "./detail.js";

// Each edge gets a synthesized `id` derived from `${from}::${to}::${type}`
// so `solid-js/store`'s `reconcile({ key: "id" })` can preserve identity
// across polls. Edges come from `normalizeSnapshot` as fresh clones, so
// mutating them to attach the key is safe and does not affect the input.
function attachEdgeId(edge) {
  if (!edge || typeof edge !== "object") return edge;
  if (edge.id == null) edge.id = edgeKey(edge);
  return edge;
}

const initialTransport = {
  generated_at: null,
  initialLoading: true,
  refreshing: false,
  snapshotError: null,
  lastSuccessfulAt: null,
  readAlerts: [],
  lastSnapshotAt: null,
};

const initialUi = {
  route: "overview",
  selectedId: null,
  detailId: null,
  detail: null,
  detailError: null,
};

const initialEntities = {
  initiatives: {},
  nodes: {},
  edges: [],
  plugins: {},
};

const initialViews = {
  derived: { ready: [], submitted: [], blocked: [], backlog: [], openGates: [] },
};

function readDerived(snapshot) {
  const d = snapshot && snapshot.derived;
  if (!d || typeof d !== "object") {
    return { ready: [], submitted: [], blocked: [], backlog: [], openGates: [] };
  }
  return {
    ready: Array.isArray(d.ready) ? d.ready.slice() : [],
    submitted: Array.isArray(d.submitted) ? d.submitted.slice() : [],
    blocked: Array.isArray(d.blocked) ? d.blocked.slice() : [],
    backlog: Array.isArray(d.backlog) ? d.backlog.slice() : [],
    openGates: Array.isArray(d.openGates) ? d.openGates.slice() : [],
  };
}

function readReadAlerts(snapshot) {
  const alerts = snapshot && snapshot.alerts;
  return Array.isArray(alerts) ? alerts.slice() : [];
}

export function createReactiveStore() {
  const [store, setStore] = createSolidStore({
    transport: { ...initialTransport },
    ui: { ...initialUi },
    entities: { initiatives: {}, nodes: {}, edges: [], plugins: {} },
    views: { derived: { ready: [], submitted: [], blocked: [], backlog: [], openGates: [] } },
    details: {},
  });

  // Apply a normalized snapshot. Each entity slice is reconciled with a
  // stable identity key so unchanged entities keep their previous
  // reference. `plugins` always normalizes to `{}` when the snapshot
  // does not provide one (handled by `normalizeSnapshot`).
  function ingestSnapshot(snapshot) {
    const entities = normalizeSnapshot(snapshot);
    const derived = readDerived(snapshot);
    const readAlerts = readReadAlerts(snapshot);

    const edges = stableEdges(entities.edges).map(attachEdgeId);

    setStore("transport", {
      generated_at: snapshot && snapshot.generated_at != null ? snapshot.generated_at : null,
      lastSnapshotAt: snapshot && snapshot.generated_at != null ? snapshot.generated_at : null,
      readAlerts,
    });

    setStore(
      "entities",
      "initiatives",
      reconcile(stableInitiatives(entities.initiatives), {
        key: keyForInitiative,
      })
    );
    setStore(
      "entities",
      "nodes",
      reconcile(stableNodes(entities.nodes), { key: "id" })
    );
    setStore("entities", "edges", reconcile(edges, { key: "id" }));
    setStore(
      "entities",
      "plugins",
      reconcile(stablePlugins(entities.plugins), { key: keyForPlugin })
    );

    setStore("views", "derived", derived);
  }

  // Store the extras returned by GET /api/node/:id into details[id].
  // The base entity stays in entities.nodes[id] untouched, so a poll
  // that updates the base never replaces the detail entry.
  function ingestDetail(id, payload) {
    if (!applyDetail(setStore, id, payload)) return false;
    setStore("ui", "detailId", id);
    setStore("ui", "detail", payload);
    return true;
  }

  function dropDetail(id) {
    clearDetail(setStore, id);
    if (id && store.ui.detailId === id) {
      setStore("ui", "detailId", null);
      setStore("ui", "detail", null);
    }
  }

  function dropAllDetails() {
    clearAllDetails(setStore);
    setStore("ui", "detailId", null);
    setStore("ui", "detail", null);
  }

  const actions = {
    ingestSnapshot,
    ingestDetail,
    clearDetail: dropDetail,
    clearAllDetails: dropAllDetails,

    setTransportInitialLoading(value) {
      setStore("transport", "initialLoading", !!value);
    },
    setTransportRefreshing(value) {
      setStore("transport", "refreshing", !!value);
    },
    setTransportSnapshotError(message) {
      setStore("transport", "snapshotError", message || null);
    },
    setTransportLastSuccessfulAt(iso) {
      setStore("transport", "lastSuccessfulAt", iso || null);
    },
    setTransportGeneratedAt(iso) {
      setStore("transport", "generated_at", iso || null);
    },
    setTransportReadAlerts(alerts) {
      setStore("transport", "readAlerts", Array.isArray(alerts) ? alerts.slice() : []);
    },

    setUiRoute(route) {
      setStore("ui", "route", route);
    },
    setUiSelectedId(id) {
      setStore("ui", "selectedId", id || null);
    },
    setUiDetailId(id) {
      setStore("ui", "detailId", id || null);
    },
    setUiDetail(payload) {
      setStore("ui", "detail", payload || null);
    },
    setUiDetailError(message) {
      setStore("ui", "detailError", message || null);
    },

    selectors: {
      tasksByStatus() {
        return tasksByStatus(store.entities, store.views.derived);
      },
      openGates() {
        return openGates(store.entities, store.views.derived);
      },
      nodesMap() {
        return nodesMap(store.entities);
      },
    },
  };

  return { store, actions };
}
