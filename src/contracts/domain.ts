export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type NodeKind = "resolvable" | "knowledge";
export type ResolvableSubkind = "task" | "gate";
export type NodeSubkind = ResolvableSubkind;

export type TaskStatus = "open" | "in_progress" | "submitted" | "done" | "archived" | "canceled";
export type GateStatus = "open" | "resolved" | "superseded" | "canceled" | "archived";
export type KnowledgeStatus = "active" | "deprecated" | "superseded";
export type PersistedNodeStatus = TaskStatus | GateStatus | KnowledgeStatus;
export type DerivedNodeStatus = "ready" | "blocked" | "unknown";
export type NodeStatus = PersistedNodeStatus | DerivedNodeStatus;
export type LifecycleStatus = PersistedNodeStatus | "ready" | "blocked" | "unknown";

export type EdgeType = "BLOCKS" | "SUPERSEDES" | "DERIVED_FROM";

export interface ExternalReference {
  type: "external" | string;
  target: string;
  [key: string]: unknown;
}

export interface Claim {
  by: string;
  at?: string;
  released_at?: string;
  submitted_at?: string;
  [key: string]: unknown;
}

export interface GateResolution {
  choice: string;
  rationale: string;
}

export interface KnowledgeScope {
  domains: string[];
  initiatives: string[];
  tags: string[];
  node_ids: string[];
}

export interface DomainNode {
  id: string;
  kind: NodeKind;
  title: string;
  body: string;
  status: PersistedNodeStatus;
  initiative?: string;
  domain?: string;
  tags?: string[];
  refs?: ExternalReference[];
  meta?: Record<string, unknown>;
  backlog?: boolean;
  revision?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface TaskNode extends DomainNode {
  kind: "resolvable";
  subkind: "task";
  status: TaskStatus;
  acceptance: string;
  resolution_mode?: "labor";
  definition?: string;
  claim?: Claim;
}

export type GatePurpose = "decision" | "approval" | "external-dependency" | "research" | string;
export type GateResolutionMode = "choice" | "labor" | string;

export interface GateNode extends DomainNode {
  kind: "resolvable";
  subkind: "gate";
  status: GateStatus;
  purpose: GatePurpose;
  resolution_mode: GateResolutionMode;
  definition?: string;
  acceptance?: string;
  resolution?: GateResolution;
}

export interface KnowledgeNode extends DomainNode {
  kind: "knowledge";
  status: KnowledgeStatus;
  knowledge_type: string;
  scope: KnowledgeScope;
  mitigation?: string;
}

export interface UnknownNode extends DomainNode {
  subkind?: NodeSubkind;
  status: PersistedNodeStatus;
}

export type Node = TaskNode | GateNode | KnowledgeNode | UnknownNode;
export type NodeSeed = Omit<TaskNode, "revision"> | Omit<GateNode, "revision"> | Omit<KnowledgeNode, "revision"> | Omit<UnknownNode, "revision">;

export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface Initiative {
  desc?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  action: string;
  agent: string;
  at?: string;
  node?: string;
  [key: string]: unknown;
}

export interface ProjectState {
  version: 1;
  fence_generation: number;
  revision: number;
  initiatives: Record<string, Initiative>;
  nodes: Record<string, Node>;
  edges: Edge[];
  log: LogEntry[];
  plugins?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export type StateSnapshot = ProjectState;

export interface LifecycleTransition {
  from?: LifecycleStatus;
  to: LifecycleStatus;
  at?: string;
  by?: string;
  reason?: string;
}

export interface NodeTarget {
  id: string;
  kind?: NodeKind;
  subkind?: ResolvableSubkind;
  revision?: number;
}
