// decisions: list all decisions, with title, status, choice, rationale.
import { readState } from "../state.mjs";

export const knownFlags = ["initiative"];

export default async function decisions({ statePath, flags }) {
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");
  const s = await readState(projectDir);
  if (!s) return [];
  const wantInit = flags.initiative;
  const out = [];
  for (const d of Object.values(s.decisions)) {
    if (wantInit && d.initiative !== wantInit) continue;
    // Normalize: every decision has a status; default to "open" if absent.
    out.push({ status: "open", ...d });
  }
  return out;
}
