// T-plugin-core-foundation — registry de operaciones core V2 para
// plugins (ADR-006 §"Registry y adaptación").
//
// La registry es un objeto plano `op → entry` con metadatos puros
// (sin argv, sin I/O) que el adaptador (`plugin-core-adapter.mjs`,
// tarea T-plugin-core-api) consume para traducir `core.run({ op,
// input })` en una llamada directa al handler correspondiente del
// core. La registry NO ejecuta argv ni reescribe flags por sí misma.
//
// El primer hito cubre cinco operaciones, exactamente las que la
// tarea `T-plugin-core-foundation` define como first slice. La tarea
// `T-plugin-core-parity` añadirá las once restantes:
//   initiative.create, task.update, task.release, task.reopen,
//   task.cancel, gate.create, gate.resolve, gate.reopen,
//   gate.cancel, knowledge.create, knowledge.deprecate.
//
// Cada entry expone:
//   handler       — función core (default export del comando V2).
//   positional    — lista de campos del input que el adaptador pasa
//                   como posición `[ id, ... ]` al handler.
//   required      — campos del input que el adaptador exige antes de
//                   llamar al handler (la validación de dominio sigue
//                   viviendo en el handler; esta lista sólo evita
//                   misses obvios y mejora el mensaje de error).
//   snakeToFlag   — mapeo input.snake_case → flag.kebab-case que el
//                   adaptador reenvía al handler.
//   expose        — campos booleanos: el adaptador fija `flags.as`
//                   desde `api.runtime.agent` y rechaza cualquier
//                   `input.as` (expose.as = false). El escape del
//                   CLI `allow-unregistered-initiative` tampoco se
//                   expone al input del plugin.

import addTask from "./commands/add-task.mjs";
import addEdge from "./commands/add-edge.mjs";
import take from "./commands/take.mjs";
import resolve from "./commands/resolve.mjs";
import addNote from "./commands/add-note.mjs";

// Tarea.create → src/commands/add-task.mjs.
// El id es posicional opcional; los flags requeridos son los que el
// core ya exige (ADR-006 §"Registry y adaptación"): initiative, title,
// body, acceptance, blocked-by. El adaptador añade `as` por su cuenta
// desde `api.runtime.agent`; permitimos que el plugin pase los demás
// campos válidos (refs, meta, tags, etc.).
const taskCreateEntry = {
  handler: addTask,
  positional: ["id"],
  required: ["initiative", "title", "body", "acceptance", "blocked-by"],
  snakeToFlag: {
    initiative: "initiative",
    title: "title",
    body: "body",
    acceptance: "acceptance",
    blocked_by: "blocked-by",
    supersedes: "supersedes",
    derived_from: "derived-from",
    domain: "domain",
    tags: "tags",
    refs: "refs",
    meta: "meta",
    backlog: "backlog",
  },
  expose: { as: false, allow_unregistered_initiative: false },
};

// edge.add → src/commands/add-edge.mjs.
// Posicional [from, to]; --type es obligatorio.
const edgeAddEntry = {
  handler: addEdge,
  positional: ["from", "to"],
  required: ["type"],
  snakeToFlag: { type: "type" },
  expose: { as: false },
};

// task.take → src/commands/take.mjs.
// Sin flags requeridos: `take` sólo necesita el id posicional.
const taskTakeEntry = {
  handler: take,
  positional: ["id"],
  required: [],
  snakeToFlag: {},
  expose: { as: false },
};

// task.resolve → src/commands/resolve.mjs.
// ADR §"Registry y adaptación": `--note` es flag obligatorio para
// tasks (resolve es {nodo: id, nota}). El adaptador traduce `note` en
// snake_case → `note` como flag kebab (no hay transformación visible).
const taskResolveEntry = {
  handler: resolve,
  positional: ["id"],
  required: ["note"],
  snakeToFlag: { note: "note" },
  expose: { as: false },
};

// note.add → src/commands/add-note.mjs.
// Posicional [id, text]; `text` es obligatorio (un add-note vacío no
// tiene sentido). El handler hace `rest.join(" ")` pero el adaptador
// sólo encola la cadena exacta del input.
const noteAddEntry = {
  handler: addNote,
  positional: ["id", "text"],
  required: ["text"],
  snakeToFlag: {},
  expose: { as: false },
};

export const CORE_REGISTRY = Object.freeze({
  "task.create": taskCreateEntry,
  "edge.add": edgeAddEntry,
  "task.take": taskTakeEntry,
  "task.resolve": taskResolveEntry,
  "note.add": noteAddEntry,
});

export const SUPPORTED_OPS = Object.freeze(Object.keys(CORE_REGISTRY));
