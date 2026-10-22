import type { GraphProjection } from "../kernel/graph.ts";
import type { ReadModelSnapshot } from "./types.ts";

export interface ProjectionArgs {
  snapshot?: ReadModelSnapshot;
  id?: string;
  graph?: GraphProjection;
}

export function projectionArgs(input: ReadModelSnapshot | ProjectionArgs | undefined, id?: string, graph?: GraphProjection): ProjectionArgs {
  if (input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "snapshot")) {
    const args = input as ProjectionArgs;
    return { snapshot: args.snapshot, id: args.id, graph: args.graph };
  }
  return { snapshot: input as ReadModelSnapshot | undefined, id, graph };
}
