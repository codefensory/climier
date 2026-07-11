// next-id: read-only. Returns the next free task id for a given phase.
// e.g. `climier next-id F1` -> { "next": "F1.T3" }
//      `climier next-id F1 --suffix R` -> { "next": "F1.T1R" }
// Used as a building block by `add-task --phase` and by humans/scripts that
// want to plan a batch of tasks before creating them.
import { readState } from "../state.mjs";
import { nextTaskId } from "../dag.mjs";

export const knownFlags = ["suffix"];

export default async function nextId({ statePath, flags, positional }) {
  const [phase] = positional;
  if (!phase) throw new Error("next-id: phase required (e.g. next-id F1)");
  if (positional.length > 1) throw new Error("next-id: only one phase allowed");
  if (typeof phase !== "string" || phase.length === 0) {
    throw new Error("next-id: phase must be a non-empty string");
  }
  if (flags.suffix === true) {
    throw new Error("next-id: --suffix requires a value (e.g. --suffix R)");
  }
  // nextTaskId itself throws on invalid suffix (empty, with dot, OPEN).
  // Passing undefined means "no suffix" — the default-family counter.
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");
  const s = await readState(projectDir);
  return { next: nextTaskId(s || { tasks: {} }, phase, flags.suffix) };
}
