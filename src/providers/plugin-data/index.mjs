// Pure plugin-data providers for the graph-kernel mutation frontier.
// Providers validate typed requests and mutate only the transaction draft;
// locking, persistence, revision assignment and audit logging remain owned by
// kernel.mutate.

export { pluginDataNodeSetProvider, nodeSetProvider } from "./node.mjs";
export { pluginDataProjectSetProvider, projectSetProvider } from "./project.mjs";
