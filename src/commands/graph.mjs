// graph: print the DAG as text lines.
import { readState } from "../state.mjs";
import { statusOf } from "../dag.mjs";

export default async function graph({ statePath, flags }) {
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");
  const s = await readState(projectDir);
  if (!s) return [];
  const lines = [];
  lines.push("DECISIONS:");
  for (const d of Object.values(s.decisions)) {
    lines.push(`  [D] ${d.id}  ${d.title || ""}  ${d.status === "decided" ? "✓ " + d.choice : "open"}`);
  }
  lines.push("");
  lines.push("TASKS:");
  for (const t of Object.values(s.tasks)) {
    const st = statusOf(s, t.id);
    const deps = (t.depends_on || []).join(", ");
    lines.push(`  [${st[0]?.toUpperCase() || "?"}] ${t.id}  ${t.title || ""}  deps:[${deps}]  ${t.claimed_by ? "@" + t.claimed_by : ""}`);
  }
  return lines;
}
