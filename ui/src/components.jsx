// Shared presentational bits: status/kind badges, chips, section wrapper.

const STATUS_STYLES = {
  ready: "bg-emerald-500/10 text-emerald-700 border-emerald-600/30",
  in_progress: "bg-sky-500/10 text-sky-700 border-sky-600/30",
  blocked: "bg-rose-500/10 text-rose-700 border-rose-600/30",
  backlog: "bg-slate-500/10 text-slate-600 border-slate-500/30",
  done: "bg-emerald-500/5 text-emerald-700/80 border-emerald-600/20",
  canceled: "bg-slate-500/10 text-slate-500 border-slate-500/30",
  open: "bg-amber-500/10 text-amber-700 border-amber-600/30",
  resolved: "bg-teal-500/10 text-teal-700 border-teal-600/30",
  superseded: "bg-purple-500/10 text-purple-700 border-purple-600/30",
  active: "bg-violet-500/10 text-violet-700 border-violet-600/30",
  deprecated: "bg-slate-500/10 text-slate-500 border-slate-500/30",
  missing: "bg-red-500/10 text-red-700 border-red-600/30",
  archived: "bg-slate-500/10 text-slate-500 border-slate-500/30",
};

const KIND_STYLES = {
  task: "text-sky-700",
  gate: "text-amber-700",
  knowledge: "text-violet-700",
};

export function StatusBadge(props) {
  const style = STATUS_STYLES[props.status] || STATUS_STYLES.missing;
  return (
    <span class={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${style}`}>
      {props.status}
    </span>
  );
}

export function KindBadge(props) {
  const cls = KIND_STYLES[props.kind] || "text-slate-500";
  return <span class={`text-[11px] font-semibold uppercase tracking-wider ${cls}`}>{props.kind}</span>;
}

export function Chip(props) {
  return (
    <span class="inline-flex items-center rounded-full bg-panel-2 px-1.5 py-0.5 text-[11px] text-slate-600 border border-line">
      {props.children}
    </span>
  );
}

export function Section(props) {
  return (
    <section class="rounded-lg border border-line bg-panel">
      <div class="flex items-center justify-between border-b border-line px-3 py-2">
        <h3 class="mono text-[11px] font-semibold uppercase tracking-wider text-slate-500">{props.title}</h3>
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
      <div class="mono mt-0.5 text-[11px] uppercase tracking-wider text-slate-500">{props.label}</div>
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
