
import { listSnapshots } from "../../storage/state.ts";

export const knownFlags = [];

export default async function snapshots({ statePath }) {
  const projectDir = statePath;
  const list = await listSnapshots(projectDir);
  return { snapshots: list };
}
