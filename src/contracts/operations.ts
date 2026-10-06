import type {
  Edge,
  Node,
  NodeSeed,
  NodeTarget,
  ProjectState,
  StateSnapshot,
} from "./domain.ts";

export type Actor = string;
export type OperationId = string;
export type JsonRecord = Record<string, unknown>;

export interface OperationRequest<I = unknown> {
  action: OperationId;
  actor: Actor;
  input?: I;
  if_state_revision?: number;
  if_revision?: RevisionPrecondition;
}

export type RevisionPrecondition =
  | { kind: "single"; id: string; value: number }
  | { kind: "multi"; values: Record<string, number> }
  | { kind: "none" };

export interface TransactionDraft {
  getNode(id: string): Node | undefined;
  createNode(node: NodeSeed): Node;
  updateNode(id: string, patch: Partial<Node>): Node;
  addEdge(edge: Edge): unknown;
  removeEdge(edge: Edge): unknown;
  view(): ProjectState;
}

export interface PrepareArgs<I = unknown> {
  snapshot: StateSnapshot;
  input: I;
  request: OperationRequest<I>;
}

export interface ApplyArgs<I = unknown, P = unknown> {
  tx: TransactionDraft;
  plan: P;
  input: I;
  request: OperationRequest<I>;
  snapshot: StateSnapshot;
}

export interface ApplyResult<R = unknown, E = unknown> {
  result: R;
  effects?: E;
}

export interface Provider<I = unknown, P = unknown, R = unknown, E = unknown> {
  prepare(args: PrepareArgs<I>): P | Promise<P>;
  apply(args: ApplyArgs<I, P>): ApplyResult<R, E> | Promise<ApplyResult<R, E>>;
}

export type ProviderKind = "task" | "gate" | "knowledge" | "core";

export interface OperationEntry<I = unknown, P = unknown, R = unknown, E = unknown> {
  id: OperationId;
  kind: ProviderKind;
  provider: Provider<I, P, R, E>;
}

export interface OperationRegistry {
  readonly ops: readonly OperationId[];
  readonly entries: ReadonlyMap<OperationId, OperationEntry>;
  readonly providers: ReadonlyMap<OperationId, Provider>;
  readonly byKind: ReadonlyMap<ProviderKind, readonly OperationId[]>;
  has(id: OperationId): boolean;
  get(id: OperationId): OperationEntry | undefined;
  lookup(id: OperationId): OperationEntry | null;
  list(kind?: ProviderKind): readonly OperationId[];
}

export interface PolicyDecision {
  decision: "allow" | "deny" | "abstain";
  reason?: string;
}

export interface PolicyContext {
  action: OperationId;
  actor: Actor;
  target?: NodeTarget;
  snapshot: StateSnapshot;
  projectDir: string;
  projectConfig?: JsonRecord;
}

export interface PolicyDefinition {
  authorize(args: PolicyContext): PolicyDecision | Promise<PolicyDecision>;
  applies?(projectConfig: JsonRecord): boolean | Promise<boolean>;
}

export interface Policy {
  pluginId: string;
  namespace?: string;
  policy: PolicyDefinition;
  projectConfig?: JsonRecord;
  descriptor?: JsonRecord;
  entryPath?: string;
  installedDir?: string;
}

export interface PolicyAction {
  action?: OperationId;
  pluginId?: string | null;
  decide(args: PolicyContext): PolicyDecision | Promise<PolicyDecision>;
}

export type LoadPolicy = (args: { projectDir: string }) => Promise<Policy | null>;
export type AuthorizeAction = (args: {
  policy: Policy;
  action: OperationId;
  actor: Actor;
  target?: NodeTarget;
  snapshot: StateSnapshot;
  projectDir: string;
  projectConfig?: JsonRecord;
}) => PolicyDecision | Promise<PolicyDecision>;

export interface Mutation {
  projectDir: string;
  request: OperationRequest;
  provider?: Provider;
  policyAction?: PolicyAction;
  policyActionFromPlan?: boolean;
  pluginId?: string;
  stateOperation?: unknown;
  batch?: { registry: OperationRegistry };
}

export type MutateFn = (mutation: Mutation) => Promise<unknown>;

export interface OperationSource {
  registry: OperationRegistry;
  mutate: MutateFn;
  loadPolicy?: LoadPolicy;
  authorizeAction?: AuthorizeAction;
  pluginId?: string;
}
