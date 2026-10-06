export interface ReadModelClaim {
  by?: string;
  at?: string | number | null;
  [key: string]: unknown;
}

export interface ReadModelRef {
  target?: string;
  type?: string;
  source?: string;
  [key: string]: unknown;
}

export interface ReadModelNote {
  text?: string;
  [key: string]: unknown;
}

export interface ReadModelNode {
  id: string;
  kind?: string;
  subkind?: string;
  status?: string;
  title?: string;
  body?: string;
  mitigation?: string;
  definition?: string;
  acceptance?: string;
  initiative?: string;
  domain?: string;
  tags?: string[];
  refs?: Array<ReadModelRef | string>;
  meta?: unknown;
  claim?: ReadModelClaim | null;
  claimed_by?: string | null;
  claimed_at?: string | number | null;
  revision?: number;
  backlog?: boolean;
  placeholder?: boolean;
  purpose?: string;
  scope?: Record<string, unknown>;
  knowledge_type?: string;
  deprecation_reason?: string;
  deprecated_at?: string;
  deprecated_by?: string;
  superseded_by?: string;
  notes?: ReadModelNote[];
  plugins?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ReadModelEdge {
  from: string;
  to: string;
  type: string;
  [key: string]: unknown;
}

export interface ReadModelInitiative {
  desc?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface ReadModelLogEntry {
  action?: string;
  agent?: string;
  node?: string;
  task?: string;
  ts?: unknown;
  note?: unknown;
  at?: string;
  [key: string]: unknown;
}

export interface ReadModelSnapshot {
  nodes?: Record<string, ReadModelNode>;
  edges?: ReadModelEdge[];
  initiatives?: Record<string, ReadModelInitiative>;
  log?: ReadModelLogEntry[];
  plugins?: Record<string, unknown>;
  revision?: number;
  [key: string]: unknown;
}

export interface ReadModelDerived {
  ready: string[];
  blocked: string[];
  backlog: string[];
  openGates: string[];
  submitted?: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
