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
      const title = t.title ? `  ${t.title}` : "";
      lines.push(`  ${t.id}${title}  @${t.claimed_by}  ${Math.round(t.age_ms / 60000)}m`);
    }
  }

  if (s.ready && s.ready.length) {
    lines.push("");
    lines.push(`READY (${s.ready.length} claimable):`);
    for (const r of s.ready) {
      if (typeof r === "string") lines.push(`  ${r}`);
      else lines.push(`  ${r.id}  ${r.title || ""}`.trimEnd());
    }
  }

  if (s.blocked_by_decision && Object.keys(s.blocked_by_decision).length) {
    lines.push("");
    lines.push("BLOCKED BY DECISION:");
    for (const [did, tids] of Object.entries(s.blocked_by_decision)) {
      const fmt = (t) => (typeof t === "string" ? t : `${t.id} (${t.title || "?"})`);
      lines.push(`  ${did} → ${tids.map(fmt).join(", ")}`);
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

export function formatGotchas(arr) {
  if (!arr.length) return "(no gotchas)";
  const lines = ["─── GOTCHAS ───"];
  for (const g of arr) {
    lines.push(`  [${g.id}] ${g.title || ""}`);
    lines.push(`        applies_to: ${(g.applies_to || []).join(", ")}  initiative: ${g.initiative || "-"}  status: ${g.status || "active"}`);
    if (g.mitigation) lines.push(`        mitigation: ${g.mitigation}`);
  }
  return lines.join("\n");
}

export function formatDecisions(arr) {
  if (!arr.length) return "(no decisions)";
  const lines = ["─── DECISIONS ───"];
  for (const d of arr) {
    const status = d.status === "decided" ? `✓ decided → ${d.choice}` : "○ open";
    lines.push(`  [${d.id}]  ${d.title || ""}  ${status}  [${d.initiative || "?"}]`);
    if (d.rationale) lines.push(`        rationale: ${d.rationale}`);
  }
  return lines.join("\n");
}

export function formatLog(arr) {
  if (!arr.length) return "(no log entries)";
  const lines = ["─── LOG ───"];
  for (const e of arr) {
    const parts = [e.ts, e.agent, e.action];
    if (e.task) parts.push(`task=${e.task}`);
    if (e.decision) parts.push(`decision=${e.decision}`);
    if (e.note) parts.push(`"${e.note}"`);
    lines.push(`  ${parts.join("  ")}`);
  }
  return lines.join("\n");
}

export function formatPreClaim(p) {
  const lines = [];
  lines.push(`─── PRE-CLAIM ${p.id}: ${p.title} ───`);
  lines.push(`initiative: ${p.initiative || "?"}    domain: ${p.domain || "-"}    skills: ${(p.skills || []).join(", ") || "-"}`);
  lines.push(`derived_status: ${p.derived_status}    can_claim: ${p.can_claim ? "YES" : "NO"}`);
  if (p.depends_on && p.depends_on.length) lines.push(`depends_on: ${p.depends_on.join(", ")}`);
  lines.push("");
  lines.push("DEFINITION:");
  lines.push(`  ${p.definition}`);
  lines.push("");
  lines.push("ACCEPTANCE:");
  lines.push(`  ${p.acceptance}`);
  if (p.gotchas && p.gotchas.length) {
    lines.push("");
    lines.push("GOTCHAS (read before claiming):");
    for (const g of p.gotchas) {
      lines.push(`  ⚠ [${g.id}] ${g.title}`);
      if (g.mitigation) lines.push(`     mitigation: ${g.mitigation}`);
    }
  }
  if (p.claim) {
    lines.push("");
    lines.push("CURRENT CLAIM:");
    lines.push(`  by: ${p.claim.by || "(unknown)"}`);
    if (p.claim.age_ms !== null && p.claim.age_ms !== undefined) {
      lines.push(`  age: ${Math.round(p.claim.age_ms / 60000)}m`);
    }
    if (p.claim.block_reason) lines.push(`  block_reason: ${p.claim.block_reason}`);
  }
  if (p.blockers && p.blockers.length) {
    lines.push("");
    lines.push("BLOCKERS:");
    for (const b of p.blockers) lines.push(`  ✗ ${b}`);
  }
  if (p.warnings && p.warnings.length) {
    lines.push("");
    lines.push("WARNINGS:");
    for (const w of p.warnings) lines.push(`  ! ${w}`);
  }
  lines.push("");
  lines.push(p.can_claim ? "→ ready to claim" : "→ do not claim");
  return lines.join("\n");
}

export function formatShow({ type, node }) {
  const lines = [`─── SHOW ${type.toUpperCase()}: ${node.id} ───`];
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "object" && v !== null) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`  ${k}: ${v}`);
    }
  }
  return lines.join("\n");
}
