// gotchas.mjs: resolve gotchas for a task (by domain or task id).
export function forTask(state, task) {
  if (!state || !state.gotchas || !task) return [];
  const want = new Set();
  if (task.domain) want.add(`domain:${task.domain}`);
  if (task.id) want.add(task.id);
  const out = [];
  for (const g of Object.values(state.gotchas)) {
    if (g.status === "resolved") continue;
    const applies = (g.applies_to || []).some((a) => want.has(a));
    if (applies) out.push(g);
  }
  return out;
}
