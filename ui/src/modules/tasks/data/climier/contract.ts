/**
 * Contrato de lectura de `climier`.
 *
 * Estos tipos describen **tal cual** lo que devuelve el server de climier
 * (`GET /api/snapshot` y `GET /api/node/:id`, ver `climier/ui/server/server.mjs` y
 * `climier/src/read-model/`). No son un modelo de la UI: son la frontera. La UI nunca
 * inventa un campo, sólo proyecta (`projection.ts`) lo que está acá.
 *
 * La regla para este archivo: si climier agrega o renombra un campo, se toca acá y la
 * proyección lo expone; ningún componente del board lee el snapshot directamente.
 *
 * El vocabulario es el de climier a propósito (`kind`, `subkind`, `BLOCKS`, `claim`,
 * `revision`, `derived_status`). No se traduce: la UI enseña el modelo, no lo esconde.
 */

// ─── Vocabulario ──────────────────────────────────────────────────────────────────────────────

/** Todo elemento del DAG es un node. */
export type ClimierNodeKind = "resolvable" | "knowledge";

/** Los resolvables se parten en dos: trabajo ejecutable (task) y decisión/dependencia (gate). */
export type ClimierResolvableSubkind = "task" | "gate";

/** Estados persistidos de una task (`open` + flag `backlog` da el estado derivado `backlog`). */
export type ClimierTaskStatus = "open" | "in_progress" | "submitted" | "done" | "archived" | "canceled";

/** Estados persistidos de una gate. */
export type ClimierGateStatus = "open" | "resolved" | "superseded" | "canceled";

/** Estados de un knowledge node. */
export type ClimierKnowledgeStatus = "active" | "deprecated" | "superseded";

/** Tipos de edge. `INFORMS` lo usa la proyección de knowledge. */
export type ClimierEdgeType = "BLOCKS" | "SUPERSEDES" | "DERIVED_FROM" | "INFORMS";

/** Una referencia estructurada. `source` distingue la explícita de la detectada en texto. */
export type ClimierRef = {
  target: string;
  type: string;
  source: string;
};

/** Una nota del thread append-only. `agent` puede ser una persona o un agente. */
export type ClimierNote = {
  ts: string;
  agent: string;
  text: string;
};

/** Claim actual de una task o gate. `at` puede venir como ISO o epoch-ms. */
export type ClimierClaim = {
  by: string;
  at: string | number | null;
};

/** Scope de un knowledge node: por qué nodos aplica. */
export type ClimierScope = {
  domains?: string[];
  initiatives?: string[];
  tags?: string[];
  node_ids?: string[];
};

/** Un nodo del DAG, tal cual está persistido. Los campos de gate/knowledge son opcionales. */
export type ClimierNode = {
  id: string;
  kind: ClimierNodeKind;
  subkind?: ClimierResolvableSubkind;
  title: string;
  body?: string;
  /** Criterio de aceptación de una task. */
  acceptance?: string;
  /** Definición/alcance de una task. */
  definition?: string;
  refs?: Array<string | Partial<ClimierRef> | null>;
  tags?: string[];
  initiative?: string;
  domain?: string;
  status?: ClimierTaskStatus | ClimierGateStatus | ClimierKnowledgeStatus;
  /** Si es `true`, una task `open` se deriva como `backlog` en vez de `ready`. */
  backlog?: boolean;
  claim?: ClimierClaim | null;
  notes?: ClimierNote[];
  meta?: Record<string, unknown>;
  resolution_mode?: string;
  revision?: number;
  // Ciclo de vida (los escribe el CLI al submit/accept/done)
  done_by?: string;
  done_at?: string;
  submitted_by?: string;
  submitted_at?: string;
  accepted_by?: string;
  accepted_at?: string;
  note?: string;
  // Gate
  purpose?: string;
  resolution?: { choice?: string; rationale?: string };
  // Knowledge
  knowledge_type?: string;
  mitigation?: string;
  scope?: ClimierScope;
  deprecation_reason?: string;
  deprecated_at?: string;
  deprecated_by?: string;
};

/** Un edge tipado. `from BLOCKS to` significa que `from` bloquea a `to`. */
export type ClimierEdge = {
  from: string;
  to: string;
  type: ClimierEdgeType;
};

/** Una entrada del log global. `node_id`/`node_title` los agrega el server al normalizar. */
export type ClimierLogEntry = {
  ts: string;
  agent: string;
  action: string;
  node?: string | null;
  task?: string | null;
  node_id?: string | null;
  node_title?: string | null;
  note?: string;
};

/** Pools derivados globales. `submitted` lo agrega el server, no `deriveV2`. */
export type ClimierDerivedPools = {
  ready: string[];
  blocked: string[];
  backlog: string[];
  openGates: string[];
  submitted?: string[];
};

/** Métricas del snapshot. Todas las claves siempre existen (0, nunca `undefined`). */
export type ClimierSummary = Record<string, number>;

/** Alerta de lectura o de claim stale. */
export type ClimierAlert = {
  kind: string;
  severity?: string;
  node_id?: string | null;
  claimed_by?: string;
  age_ms?: number;
  code?: string;
  message: string;
};

/** Una initiative registrada. */
export type ClimierInitiative = {
  desc: string;
  created_at: string;
};

/** Desglose por initiative que ya calcula el server. */
export type ClimierInitiativeSummary = {
  initiative: string;
  total: number;
  by_kind: {
    tasks: { total: number; ready: number; in_progress: number; submitted: number; blocked: number; backlog: number; done: number; archived: number; canceled: number };
    gates: { total: number; open: number; resolved: number; superseded: number };
    knowledge: { total: number; active: number; deprecated: number };
  };
};

/** Última actividad conocida de un node, tomada del log. */
export type ClimierLastActivity = {
  action: string;
  agent: string;
  ts: string;
  note?: string;
};

/** El snapshot completo: la única entrada de lectura del board. */
export type ClimierSnapshot = {
  project: {
    root: string;
    state_file: string;
    initialized: boolean;
    project_id: string | null;
  };
  generated_at: string;
  initiatives: Record<string, ClimierInitiative>;
  nodes: Record<string, ClimierNode>;
  edges: ClimierEdge[];
  derived: ClimierDerivedPools;
  last_activity: Record<string, ClimierLastActivity>;
  initiative_summary?: ClimierInitiativeSummary[];
  summary: ClimierSummary;
  alerts: ClimierAlert[];
  recent_activity: ClimierLogEntry[];
};

// ─── Detalle de un node (`GET /api/node/:id`) ────────────────────────────────────────────────

/** Un blocker entrante `BLOCKS`, con su satisfacción ya derivada. */
export type ClimierBlocker = {
  edge_type: ClimierEdgeType;
  node: ClimierNode;
  satisfied: boolean;
};

/** Un vecino saliente (dependents o informing). */
export type ClimierDependent = {
  edge_type: ClimierEdgeType;
  node: ClimierNode;
};

/** Knowledge aplicable, con los scopes que matchearon. */
export type ClimierKnowledgeMatch = ClimierNode & { scope_matches: string[] };

export type ClimierNodeDetail = {
  node: ClimierNode;
  blocking: ClimierBlocker[];
  dependents: ClimierDependent[];
  informing: ClimierDependent[];
  knowledge: ClimierKnowledgeMatch[];
  history: ClimierLogEntry[];
  refs: ClimierRef[];
  derived_status: string;
  is_current: boolean;
  superseded_by: string | null;
};
