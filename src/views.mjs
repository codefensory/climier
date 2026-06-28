// views.mjs: human-readable formatters for command outputs.
// Each formatter returns a string the CLI prints.

export function formatStatus(s) {
  const lines = [];
  lines.push("─── STATUS ───");
  if (Object.keys(s.counts).length === 0) {
    lines.push("(empty — no initiatives/tasks)");
  } else {
    lines.push("");
    lines.push("Initiative       ready  in_prog  done  blocked  skipped");
    for (const [name, c] of Object.entries(s.counts)) {
      const pad = (str, n) => String(str).padEnd(n);
      const num = (n) => String(n).padStart(5);
      lines.push(`${pad(name, 16)}${num(c.ready || 0)}  ${num(c.in_progress || 0)}  ${num(c.done || 0)}  ${num(c.blocked || 0)}  ${num(c.skipped || 0)}`);
    }
  }

  if (s.in_progress && s.in_progress.length) {
    lines.push("");
    lines.push("IN PROGRESS:");
    for (const t of s.in_progress) {
      const age = t.claimed_at ? `${Math.round((Date.now() - t.claimed_at) / 60000)}m` : "?";
      const br = t.block_reason ? `  ⚠ ${t.block_reason}` : "";
      lines.push(`  ${t.id}  ${t.title || ""}  @${t.claimed_by}  (${age})${br}`);
    }
  }

  if (s.stale && s.stale.length) {
    lines.push("");
    lines.push("STALE CLAIMS (revisar):");
    for (const t of s.stale) {
      lines.push(`  ${t.id}  @${t.claimed_by}  ${Math.round(t.age_ms / 60000)}m`);
    }
  }

  if (s.ready && s.ready.length) {
    lines.push("");
    lines.push(`READY (${s.ready.length} claimable):`);
    for (const id of s.ready) lines.push(`  ${id}`);
  }

  if (s.blocked_by_decision && Object.keys(s.blocked_by_decision).length) {
    lines.push("");
    lines.push("BLOCKED BY DECISION:");
    for (const [did, tids] of Object.entries(s.blocked_by_decision)) {
      lines.push(`  ${did} → ${tids.join(", ")}`);
    }
  }

  if (s.open_decisions && s.open_decisions.length) {
    lines.push("");
    lines.push("OPEN DECISIONS:");
    for (const id of s.open_decisions) lines.push(`  ${id}`);
  }

  if (s.active_gotchas && s.active_gotchas.length) {
    lines.push("");
    lines.push("ACTIVE GOTCHAS:");
    for (const g of s.active_gotchas) {
      lines.push(`  [${g.id}] ${g.title}  (${(g.applies_to || []).join(", ")})`);
    }
  }

  return lines.join("\n");
}

export function formatReady(arr) {
  if (!arr.length) return "(no tasks ready)";
  const lines = [];
  lines.push("─── READY (claimable now) ───");
  for (const t of arr) {
    const skills = (t.skills || []).join(",");
    lines.push(`  ${t.id}  [${t.initiative || "?"}]  ${t.title || ""}`);
    lines.push(`        skills: ${skills || "-"}  effort: ${t.effort || "?"}  domain: ${t.domain || "-"}`);
  }
  return lines.join("\n");
}

export function formatNext(n) {
  const lines = [];
  lines.push(`─── ${n.id}: ${n.title} ───`);
  lines.push(`initiative: ${n.initiative || "?"}    domain: ${n.domain || "-"}    skills: ${(n.skills || []).join(", ") || "-"}`);
  if (n.depends_on && n.depends_on.length) lines.push(`depends_on: ${n.depends_on.join(", ")}`);
  lines.push("");
  lines.push("DEFINITION:");
  lines.push(`  ${n.definition}`);
  lines.push("");
  lines.push("ACCEPTANCE:");
  lines.push(`  ${n.acceptance}`);
  if (n.gotchas && n.gotchas.length) {
    lines.push("");
    lines.push("GOTCHAS DEL DOMINIO:");
    for (const g of n.gotchas) {
      lines.push(`  ⚠ [${g.id}] ${g.title}`);
      if (g.mitigation) lines.push(`     mitigation: ${g.mitigation}`);
    }
  }
  return lines.join("\n");
}

export function formatTasks(arr) {
  if (!arr.length) return "(no tasks)";
  const lines = ["─── TASKS ───"];
  for (const t of arr) {
    const at = t.claimed_by ? `  @${t.claimed_by}` : "";
    const deps = (t.depends_on || []).length ? `  deps:[${t.depends_on.join(",")}]` : "";
    lines.push(`  [${t.status.padEnd(11)}] ${t.id.padEnd(10)}  ${t.title || ""}${at}${deps}  [${t.initiative || "?"}]`);
  }
  return lines.join("\n");
}

export function formatGraph(lines) {
  return lines.join("\n");
}

export function formatTaskShort(task) {
  return `${task.id}  ${task.title || ""}  [${task.initiative || "?"}]  → claimed by you`;
}
