// gotchas: list gotchas, optionally filtered.
import { readState } from "../state.mjs";

export default async function gotchas({ statePath, flags }) {
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");
  const s = await readState(projectDir);
  if (!s) return [];
  const wantDomain = flags.domain;
  const wantInit = flags.initiative;
  const out = [];
  for (const g of Object.values(s.gotchas)) {
    if (g.status === "resolved") continue;
    if (wantInit && g.initiative !== wantInit) continue;
    if (wantDomain) {
      const matches = (g.applies_to || []).some((a) => a === `domain:${wantDomain}` || a === wantDomain);
      if (!matches) continue;
    }
    out.push(g);
  }
  return out;
}
