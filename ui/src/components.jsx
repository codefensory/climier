// Shared presentational bits: status/kind badges, chips, section wrapper.

const STATUS_STYLES = {
  ready: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  in_progress: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  blocked: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  backlog: "bg-slate-500/15 text-slate-300 border-slate-500/40",
  done: "bg-emerald-500/10 text-emerald-400/80 border-emerald-500/25",
  canceled: "bg-slate-600/15 text-slate-400 border-slate-600/40",
  open: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  resolved: "bg-teal-500/15 text-teal-300 border-teal-500/40",
  superseded: "bg-purple-500/15 text-purple-300 border-purple-500/40",
  active: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  deprecated: "bg-slate-600/15 text-slate-400 border-slate-600/40",
  missing: "bg-red-500/15 text-red-300 border-red-500/40",
  archived: "bg-slate-600/15 text-slate-400 border-slate-600/40",
};

const KIND_STYLES = {
  task: "text-sky-300",
  gate: "text-amber-300",
  knowledge: "text-violet-300",
};

export function StatusBadge(props) {
  const style = STATUS_STYLES[props.status] || STATUS_STYLES.missing;
  return (
    <span class={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${style}`}>
      {props.status}
    </span>
  );
}

export function KindBadge(props) {
  const cls = KIND_STYLES[props.kind] || "text-slate-300";
  return <span class={`text-[11px] font-semibold uppercase tracking-wider ${cls}`}>{props.kind}</span>;
}

export function Chip(props) {
  return (
    <span class="inline-flex items-center rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-slate-300 border border-line">
      {props.children}
    </span>
  );
}

export function Section(props) {
  return (
    <section class="rounded-lg border border-line bg-panel">
      <div class="flex items-center justify-between border-b border-line px-3 py-2">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400">{props.title}</h3>
        {props.right}
      </div>
      <div class="p-3">{props.children}</div>
    </section>
  );
}

export function StatCard(props) {
  return (
    <div class="rounded-lg border border-line bg-panel p-3" onClick={props.onClick}>
      <div class="text-2xl font-semibold tabular-nums">{props.value}</div>
      <div class="text-xs text-slate-400">{props.label}</div>
    </div>
  );
}

export function Empty(props) {
  return <div class="rounded-lg border border-dashed border-line p-6 text-center text-sm text-slate-500">{props.children}</div>;
}

export function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString();
}

export function lastActionLabel(action) {
  const map = {
    "add-node": "created",
    take: "claimed",
    resolve: "resolved",
    release: "released",
    reopen: "reopened",
    cancel: "canceled",
    update: "updated",
    "add-note": "note",
    supersede: "superseded",
  };
  return map[action] || action;
}
