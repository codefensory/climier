// Pure plugin-data providers for the graph-kernel mutation frontier.

// locking, persistence, revision assignment and audit logging remain owned by
// kernel.mutate.

export { pluginDataNodeSetProvider, nodeSetProvider } from "./node.ts";
export { pluginDataProjectSetProvider, projectSetProvider } from "./project.ts";
export { pluginDataNodeDeleteProvider, nodeDeleteProvider } from "./node-delete.ts";
export { pluginDataProjectDeleteProvider, projectDeleteProvider } from "./project-delete.ts";
