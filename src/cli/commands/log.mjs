// log: read and filter the append-only log.
import { projectLogView } from "../../read-model/index.mjs";
import { readState } from "../../storage/state.mjs";

export const knownFlags = ["limit", "action", "agent", "task", "decision"];

export default async function log({ statePath, flags, backendClient }) {
  if (backendClient?.type === "remote") {
    const limit = flags.limit ? Number.parseInt(flags.limit, 10) : undefined;
    return backendClient.readLog({
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      action: flags.action || undefined,
      agent: flags.agent || undefined,
      task: flags.task || undefined,
      decision: flags.decision || undefined,
    });
  }

  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) return [];
  return projectLogView({ snapshot: s, filters: flags });
}
