// log.mjs: append entries to the global state log.
import { updateState } from "./state.mjs";

export async function append(projectDir, entry) {
  return updateState(projectDir, (s) => {
    s.log = s.log || [];
    s.log.push({ ts: new Date().toISOString(), ...entry });
    return s;
  });
}
