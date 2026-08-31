// snapshots — list recoverable snapshots captured under
// `<state-dir>/snapshots/`. ADR-004 defines the snapshot command contract.
//
// Read-only. Reuses `listSnapshots` from src/storage/state.mjs, which already
// filters to complete pairs (raw + metadata), parses the metadata, and
// sorts descending by id (newest first). The command shape mirrors the
// other list-style reads: a top-level `{ snapshots: [...] }` envelope so
// consumers don't have to special-case the result type.
//
// No flags today. `knownFlags = []` makes the bin's unknown-flag gate
// catch accidental `snapshots --something`.
import { listSnapshots } from "../../storage/state.mjs";

export const knownFlags = [];

export default async function snapshots({ statePath }) {
  const projectDir = statePath;
  const list = await listSnapshots(projectDir);
  return { snapshots: list };
}