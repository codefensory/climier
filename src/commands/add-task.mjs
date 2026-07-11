// add-task: append a new task to the state. The id is either explicit
// (positional) or auto-allocated via --phase <prefix> (uses nextTaskId).
// With --phase, --suffix <S> appends S at the end of the generated id
// (e.g. --phase F1 --suffix R -> F1.T1R). --suffix without --phase is ignored.
import { updateState, readState, assertInitiativeRegistered } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { nextTaskId } from "../dag.mjs";

const VALID_PRIORITIES = ["high", "medium", "low"];

function parseBacklog(raw) {
  if (raw === true) throw new Error("add-task: --backlog requires a value (true or false)");
  const v = String(raw).toLowerCase();
  if (v !== "true" && v !== "false") {
    throw new Error(`add-task: --backlog must be 'true' or 'false' (got '${raw}')`);
  }
  return v === "true";
}

function parsePriority(raw) {
  if (raw === true) throw new Error("add-task: --priority requires a value (high, medium, or low)");
  const v = String(raw).toLowerCase();
  if (!VALID_PRIORITIES.includes(v)) {
    throw new Error(`add-task: --priority must be one of ${VALID_PRIORITIES.join(", ")} (got '${raw}')`);
  }
  return v;
}

export const knownFlags = ["initiative", "title", "depends-on", "definition", "acceptance", "skills", "effort", "domain", "phase", "suffix", "backlog", "priority"];

export default async function addTask({ statePath, flags, positional }) {
  const [explicitId] = positional;
  const phase = flags.phase;
  const suffix = flags.suffix;
  if (explicitId && phase) {
    throw new Error("add-task: pass either a positional id (e.g. add-task F1.T1) or --phase <prefix> (e.g. --phase F1), not both");
  }
  if (!explicitId && !phase) {
    throw new Error("add-task: task id required (e.g. add-task F1.T1 --initiative migration --title '...') or pass --phase <prefix> to auto-allocate");
  }
  if (suffix === true) {
    throw new Error("add-task: --suffix requires a value (e.g. --suffix R)");
  }
  if (suffix !== undefined && !phase) {
    throw new Error("add-task: --suffix can only be used with --phase");
  }
  if (!flags.initiative) throw new Error("add-task: --initiative required");
  if (!flags.title) throw new Error("add-task: --title required");
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    // Resolve the id inside the lock: nextTaskId needs a consistent view of state
    // and the result must not collide with a task created in the same race window.
    const id = explicitId || nextTaskId(s || { tasks: {} }, phase, suffix);
    if (s && s.tasks[id]) throw new Error(`add-task: ${id} already exists`);
    // Initiative must be registered. On a non-existent state file this
    // fails too (hint points to add-initiative), which is intentional:
    // bootstrap is via the seed or add-initiative first, not via add-task.
    assertInitiativeRegistered(s, flags.initiative, "add-task");
    const deps = flags["depends-on"]
      ? flags["depends-on"].split(",").map((x) => x.trim()).filter(Boolean)
      : [];
    // Validate that every declared dep points to an existing task or decision.
    // (If the state is empty, allow it; the user is starting from scratch.)
    if (s) {
      for (const dep of deps) {
        if (!s.tasks[dep] && !s.decisions[dep]) {
          throw new Error(`add-task: depends-on '${dep}' not found in tasks or decisions`);
        }
      }
    }
    const node = {
      id,
      title: flags.title,
      initiative: flags.initiative,
      definition: flags.definition || undefined,
      acceptance: flags.acceptance || undefined,
      skills: flags.skills ? flags.skills.split(",").map((x) => x.trim()).filter(Boolean) : [],
      effort: flags.effort || undefined,
      domain: flags.domain || undefined,
      depends_on: deps,
    };
    if (flags.backlog !== undefined) {
      // `--backlog false` is the default semantics (a fresh task is not in
      // backlog) so we don't write a redundant `backlog: false`. Only
      // `--backlog true` actually persists a field.
      const isBacklog = parseBacklog(flags.backlog);
      if (isBacklog) node.backlog = true;
    }
    if (flags.priority !== undefined) {
      node.priority = parsePriority(flags.priority);
    }
    await updateState(projectDir, (st) => {
      st.tasks[id] = node;
      return st;
    });
    return { task: node };
  });
}
