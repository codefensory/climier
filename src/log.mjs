// log.mjs: append entries to the global state log.
import { updateState } from "./state.mjs";

export async function append(projectDir, entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("append: entry must be an object");
  }
  if (!entry.action) {
    throw new Error("append: entry.action is required");
  }
  if (!entry.agent) {
    throw new Error("append: entry.agent is required");
  }
  return updateState(projectDir, (s) => {
    s.log = s.log || [];
    s.log.push({ ts: new Date().toISOString(), ...entry });
    return s;
  });
}
