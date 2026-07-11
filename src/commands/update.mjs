// update: edit a task's mutable fields. Atomic + audited.
// Status guard: in_progress and done are locked (release or reopen first).
// A task with no persisted status (ready or blocked) is always editable —
// changing depends_on is the supported way to unblock a task.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";

const VALID_PRIORITIES = ["high", "medium", "low"];

function parseBacklogUpdate(raw) {
  if (raw === true) throw new Error("update: --backlog requires a value (true or false)");
  const v = String(raw).toLowerCase();
  if (v !== "true" && v !== "false") {
    throw new Error(`update: --backlog must be 'true' or 'false' (got '${raw}')`);
  }
  return v === "true";
}

function parsePriorityUpdate(raw) {
  if (raw === true) throw new Error("update: --priority requires a value (high, medium, or low)");
  const v = String(raw).toLowerCase();
  if (!VALID_PRIORITIES.includes(v)) {
    throw new Error(`update: --priority must be one of ${VALID_PRIORITIES.join(", ")} (got '${raw}')`);
  }
  return v;
}

export const knownFlags = ["title", "definition", "acceptance", "skills", "effort", "domain", "body", "depends-on", "as", "backlog", "priority"];

const MUTABLE = ["title", "definition", "acceptance", "skills", "effort", "domain", "body", "depends-on", "backlog", "priority"];

// Map of kebab-case flag -> snake_case task field. Flags not in the map map to themselves.
const FIELD_FOR = { "depends-on": "depends_on" };

function parseDeps(v) {
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

export default async function update({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throw new Error("update: task id required (e.g. update T1 --title 'new title')");
  const as = flags.as;
  if (as === true) throw new Error("update: --as requires a value (e.g. --as alice)");
  if (!as) throw new Error("update: --as <agent> required (for the audit log)");

  const provided = MUTABLE.filter((f) => flags[f] !== undefined);
  if (provided.length === 0) {
    throw new Error(`update: at least one field required (valid: --${MUTABLE.join(", --")})`);
  }
  // Reject bare flags (e.g. `--title` with no value) which the parser turns into `true`.
  for (const f of provided) {
    if (flags[f] === true) throw new Error(`update: --${f} requires a value`);
  }

  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("update: state file missing; run `climier init` first");
    const t = s.tasks[id];
    if (!t) throw new Error(`update: task ${id} not found`);

    // Status guard: in_progress (someone is working) and done (audit-trail frozen)
    // are locked. Everything else — ready, blocked, archived — is editable.
    if (t.status === "in_progress") {
      throw new Error(`update: task ${id} is in_progress (release it first)`);
    }
    if (t.status === "done") {
      throw new Error(`update: task ${id} is done (reopen it first to edit)`);
    }

    // Build the patch and the log diff in one pass.
    const changes = {};
    const patch = {};
    for (const flag of provided) {
      const field = FIELD_FOR[flag] || flag;
      const before = t[field];
      let after;
      if (flag === "skills") {
        after = flags.skills ? flags.skills.split(",").map((x) => x.trim()).filter(Boolean) : [];
      } else if (flag === "depends-on") {
        after = parseDeps(flags["depends-on"]);
        // Validate every dep points to a known task or decision (no-op if deps are empty).
        for (const dep of after) {
          if (!s.tasks[dep] && !s.decisions[dep]) {
            throw new Error(`update: depends-on '${dep}' not found in tasks or decisions`);
          }
        }
      } else if (flag === "backlog") {
        after = parseBacklogUpdate(flags.backlog);
      } else if (flag === "priority") {
        after = parsePriorityUpdate(flags.priority);
      } else {
        after = flags[flag];
      }
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes[flag] = { from: before ?? null, to: after ?? null };
        patch[field] = after;
      }
    }

    if (Object.keys(patch).length === 0) {
      throw new Error("update: nothing actually changed (values match the existing task)");
    }

    const updated = await updateState(projectDir, (st) => {
      Object.assign(st.tasks[id], patch);
      // For --backlog false we want to remove the field entirely (not set it to false),
      // so the diff above sees `from: true, to: false` and the patch sets `backlog: false`.
      // Strip the field if the patch is setting it to false.
      if (patch.backlog === false) {
        delete st.tasks[id].backlog;
      }
      return st;
    });
    await append(projectDir, { agent: as, action: "update", task: id, changes });
    return { task: updated.tasks[id] };
  });
}
