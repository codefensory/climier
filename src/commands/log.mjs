// log: read and filter the append-only log.
import { readState } from "../state.mjs";

export const knownFlags = ["limit", "action", "agent", "task", "decision"];

export default async function log({ statePath, flags }) {
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) return [];
  let entries = s.log || [];
  if (flags.action) entries = entries.filter((e) => e.action === flags.action);
  if (flags.agent) entries = entries.filter((e) => e.agent === flags.agent);
  if (flags.task) entries = entries.filter((e) => e.task === flags.task);
  if (flags.decision) entries = entries.filter((e) => e.decision === flags.decision);
  if (flags.limit) {
    const n = parseInt(flags.limit, 10);
    if (Number.isFinite(n) && n > 0) entries = entries.slice(-n);
  }
  return entries;
}
