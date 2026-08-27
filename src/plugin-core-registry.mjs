// T-plugin-core-foundation + T-plugin-core-parity — registry de
// operaciones core V2 para plugins (ADR-006 §"Registry y adaptación").
//
// La registry es un objeto plano `op → entry` con metadatos puros
// (sin argv, sin I/O) que el adaptador (`plugin-core-adapter.mjs`,
// tarea T-plugin-core-api) consume para traducir `core.run({ op,
// input })` en una llamada directa al handler correspondiente del
// core. La registry NO ejecuta argv ni reescribe flags por sí misma.
//
// El primer hito (T-plugin-core-foundation) cubría cinco operaciones:
//   task.create, edge.add, task.take, task.resolve, note.add.
//
// El slice de paridad (T-plugin-core-parity) añade las once restantes,
// completando la superficie V2 prometida por la ADR-006:
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
import addInitiative from "./commands/add-initiative.mjs";
import updateV2 from "./commands/update.mjs";
import releaseV2 from "./commands/release.mjs";
import reopenV2 from "./commands/reopen.mjs";
import cancelV2 from "./commands/cancel.mjs";
import addGate from "./commands/add-gate.mjs";
import addKnowledge from "./commands/add-knowledge.mjs";
import deprecateKnowledge from "./commands/deprecate-knowledge.mjs";

// ---- First slice ----------------------------------------------------

// task.create → src/commands/add-task.mjs.
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

// ---- Parity slice (T-plugin-core-parity) ---------------------------

// initiative.create → src/commands/add-initiative.mjs.
// `name` es posicional. `desc` es flag opcional. El adaptador exige
// `name` antes del lock para fallar rápido con PLUGIN_CORE_INVALID_OPERATION.
const initiativeCreateEntry = {
  handler: addInitiative,
  positional: ["name"],
  required: ["name"],
  snakeToFlag: { desc: "desc" },
  expose: { as: false },
};

// task.update → src/commands/update.mjs.
// El handler exige al menos un campo a patchear (no se valida en el
// adaptador porque el contrato exige causa estructurada si el handler
// rechaza la petición vacía). Si el plugin pasara input vacío, el
// handler lanza un Error genérico que el adaptador envolverá como
// PLUGIN_CORE_ACTION_FAILED.
const taskUpdateEntry = {
  handler: updateV2,
  positional: ["id"],
  required: [],
  snakeToFlag: {
    title: "title",
    body: "body",
    initiative: "initiative",
    domain: "domain",
    tags: "tags",
    refs: "refs",
    meta: "meta",
    definition: "definition",
    acceptance: "acceptance",
    backlog: "backlog",
    purpose: "purpose",
    resolution_mode: "resolution-mode",
    knowledge_type: "knowledge-type",
    mitigation: "mitigation",
    if_revision: "if-revision",
    scope_domains: "scope-domains",
    scope_initiatives: "scope-initiatives",
    scope_tags: "scope-tags",
    scope_node_ids: "scope-node-ids",
  },
  expose: { as: false },
};

// task.release → src/commands/release.mjs.
// Idempotente en el handler: lo cubre el core; el adaptador sólo
// valida el id posicional. Sin flags requeridos.
const taskReleaseEntry = {
  handler: releaseV2,
  positional: ["id"],
  required: [],
  snakeToFlag: {},
  expose: { as: false },
};

// task.reopen → src/commands/reopen.mjs.
// `--reason` es flag obligatorio tanto para tasks como para gates.
const taskReopenEntry = {
  handler: reopenV2,
  positional: ["id"],
  required: ["reason"],
  snakeToFlag: { reason: "reason" },
  expose: { as: false },
};

// task.cancel → src/commands/cancel.mjs.
// `--reason` es flag obligatorio (análogamente a reopen).
const taskCancelEntry = {
  handler: cancelV2,
  positional: ["id"],
  required: ["reason"],
  snakeToFlag: { reason: "reason" },
  expose: { as: false },
};

// gate.create → src/commands/add-gate.mjs.
// Mismo patrón que task.create pero con --purpose obligatorio y la
// forma resolvable/gate. --resolution-mode queda opcional: el handler
// lo fija por defecto. blocked-by, supersedes y derived-from
// corresponden a las edges que `add-node.mjs` interpreta; aquí
// simplemente se traducen al mismo set de flags ya soportado.
const gateCreateEntry = {
  handler: addGate,
  positional: ["id"],
  required: ["initiative", "title", "body", "purpose"],
  snakeToFlag: {
    initiative: "initiative",
    title: "title",
    body: "body",
    purpose: "purpose",
    resolution_mode: "resolution-mode",
    blocked_by: "blocked-by",
    supersedes: "supersedes",
    derived_from: "derived-from",
    domain: "domain",
    tags: "tags",
    refs: "refs",
    meta: "meta",
  },
  expose: { as: false },
};

// gate.resolve → src/commands/resolve.mjs (mismo handler que task.resolve
// pero con --note reemplazado por --choice/--rationale). El handler
// decide por subkind si lo que está cerrando es una task (nota) o un
// gate (choice/rationale); el adaptador exige los flags según la op.
const gateResolveEntry = {
  handler: resolve,
  positional: ["id"],
  required: ["choice", "rationale"],
  snakeToFlag: { choice: "choice", rationale: "rationale" },
  expose: { as: false },
};

// gate.reopen → mismo handler que task.reopen; --reason obligatorio.
const gateReopenEntry = {
  handler: reopenV2,
  positional: ["id"],
  required: ["reason"],
  snakeToFlag: { reason: "reason" },
  expose: { as: false },
};

// gate.cancel → mismo handler que task.cancel; --reason obligatorio.
const gateCancelEntry = {
  handler: cancelV2,
  positional: ["id"],
  required: ["reason"],
  snakeToFlag: { reason: "reason" },
  expose: { as: false },
};

// knowledge.create → src/commands/add-knowledge.mjs.
// Igual que las otras ops generadas por addV2Node: el adaptador exige
// los flags que add-knowledge exige (initiative, title, body). El
// handler además exige al menos un --scope-*; esa validación
// "any-of" no se puede expresar con la regla actual del adaptador, así
// que queda delegada al handler y se reporta como PLUGIN_CORE_ACTION_FAILED.
const knowledgeCreateEntry = {
  handler: addKnowledge,
  positional: ["id"],
  required: ["initiative", "title", "body"],
  snakeToFlag: {
    initiative: "initiative",
    title: "title",
    body: "body",
    scope_domains: "scope-domains",
    scope_initiatives: "scope-initiatives",
    scope_tags: "scope-tags",
    scope_node_ids: "scope-node-ids",
    domain: "domain",
    tags: "tags",
    refs: "refs",
    meta: "meta",
    knowledge_type: "knowledge-type",
    mitigation: "mitigation",
    supersedes: "supersedes",
    derived_from: "derived-from",
  },
  expose: { as: false },
};

// knowledge.deprecate → src/commands/deprecate-knowledge.mjs.
// `--reason` es flag obligatorio (la ADR §"Registry y adaptación"
// exige reason para cualquier acción de soft-delete).
const knowledgeDeprecateEntry = {
  handler: deprecateKnowledge,
  positional: ["id"],
  required: ["reason"],
  snakeToFlag: { reason: "reason" },
  expose: { as: false },
};

export const CORE_REGISTRY = Object.freeze({
  // First slice (foundation).
  "task.create": taskCreateEntry,
  "edge.add": edgeAddEntry,
  "task.take": taskTakeEntry,
  "task.resolve": taskResolveEntry,
  "note.add": noteAddEntry,
  // Parity slice — completes ADR-006 §"API y compatibilidad".
  "initiative.create": initiativeCreateEntry,
  "task.update": taskUpdateEntry,
  "task.release": taskReleaseEntry,
  "task.reopen": taskReopenEntry,
  "task.cancel": taskCancelEntry,
  "gate.create": gateCreateEntry,
  "gate.resolve": gateResolveEntry,
  "gate.reopen": gateReopenEntry,
  "gate.cancel": gateCancelEntry,
  "knowledge.create": knowledgeCreateEntry,
  "knowledge.deprecate": knowledgeDeprecateEntry,
});

export const SUPPORTED_OPS = Object.freeze(Object.keys(CORE_REGISTRY));
