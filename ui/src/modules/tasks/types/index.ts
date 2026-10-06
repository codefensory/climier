import type { HugeIconAsset } from "../../core";

/**
 * Estado de una task, tal como lo deriva climier (`statusOfV2`).
 *
 * `ready` y `blocked` **no** son valores editables: se calculan desde el DAG (`BLOCKS`
 * satisfechos o no). Por eso el board no permite arrastrar tarjetas entre columnas.
 */
export type TaskStatus = "backlog" | "ready" | "in_progress" | "submitted" | "blocked" | "done" | "canceled" | "archived";

/** Estado de una gate. En el board sólo aparecen las `open`. */
export type GateStatus = "open" | "resolved" | "superseded" | "canceled";

/** Unión de los estados que puede mostrar un nodo del board. */
export type BoardStatus = TaskStatus | GateStatus;

/**
 * Un nodo del board ya proyectado desde el snapshot de climier.
 *
 * Tasks y gates comparten forma (`kind` discrimina) para que la tarjeta y la fila sean una
 * sola pieza de UI. Los campos cuentan cosas del DAG (`blockers`, `dependents`, `notes`,
 * `refs`); `progress` es una lectura del estado, no un campo persistido.
 */
export type Task = {
  id: string;
  /** Si es una task ejecutable o una gate (decisión/dependencia). */
  kind: "task" | "gate";
  title: string;
  /** Primer bloque del `body`, en una línea. Puede quedar vacío si el node no tiene body. */
  description: string;
  status: BoardStatus;
  /** `tags` del node. */
  tags: string[];
  /** Cantidad de notas del thread. */
  notes: number;
  /** Cantidad de referencias (explicitas + detectadas). */
  refs: number;
  /** Cantidad de blockers entrantes (`BLOCKS`) sin satisfacer. */
  blockers: number;
  /** Cantidad de dependents salientes (cualquier edge). */
  dependents: number;
  /** ISO de la última actividad del log, o `""` si el node no tiene eventos. */
  updatedAt: string;
  /** 0–100, derivado del estado. Ver `taskProgress()` en la proyección. */
  progress: number;
  initiative: string | null;
  domain: string | null;
  /** Agente que tiene el claim actual, o `null`. */
  claimedBy: string | null;
  /** El claim superó el umbral de stale (2 h por defecto). */
  claimStale: boolean;
  revision: number;
  /** La task está marcada como backlog en climier (pendiente de planificar). */
  backlog: boolean;
  /** Sólo gates: `decision`, `research`, `approval`, … */
  purpose?: string;
};

/** Par de tokens de un chip de tag: fondo y color de letra. */
export type TaskTagStyle = {
  background: string;
  color: string;
};

/** Vista del board. */
export type TaskView = "list" | "kanban";
export type TaskScope = "active" | "closed" | "all";
export type TaskScopeCounts = Record<TaskScope, number>;

export type TaskSortKey = "updated" | "title" | "id" | "status" | "initiative";
export type TaskSort = { key: TaskSortKey; dir: "asc" | "desc" };
export type TaskGroupBy = "status" | "tags" | "initiative" | "none";

/**
 * Qué dibuja `GroupHeader` a la izquierda del título.
 *
 * Es un discriminante y no un `JSX.Element` a propósito. Un elemento JSX guardado en los datos
 * se instancia una sola vez y reutilizar ese nodo en dos montajes es un bug en Solid; además no
 * puede viajar por `args`. Con el discriminante, `TaskGroupView` es data serializable y
 * `GroupHeader` tiene stories con Controls.
 */
export type TaskGroupGlyph =
  | { kind: "status"; status: TaskStatus }
  | { kind: "tag"; tag: string }
  | { kind: "initiative"; initiative: string }
  | { kind: "gate" }
  | { kind: "scope" }
  | { kind: "all" };

/** Grupo ya resuelto, listo para renderizar como sección de lista o columna de kanban. */
export type TaskGroupView = {
  key: string;
  label: string;
  /** Token base del grupo: tiñe fondo y borde inferior. */
  color: string;
  glyph: TaskGroupGlyph;
  tasks: Task[];
  status?: TaskStatus;
  /** El glyph ya muestra el nombre (chip del tag), así que el título se omite. */
  identityChip?: boolean;
  /** Progreso del grupo 0–100. Ver `groupProgress()` en la proyección. */
  progress: number;
  /** Override para grupos de registros que no proyectan una lista de tasks. */
  count?: number;
  /** Oculta la barra de progreso: las gates no tienen avance, así que un 0% mentiría. */
  hideProgress?: boolean;
};

/** Opción de un menú: clave, etiqueta e icono. La comparten sort y group. */
export type TaskFieldOption<K extends string = string> = {
  key: K;
  label: string;
  icon: HugeIconAsset;
};

/** Entrada de `statusOrder`. */
export type TaskStatusOption = {
  status: TaskStatus;
  label: string;
  color: string;
};

// ─── Filtros ────────────────────────────────────────────────────────────────────────────────
// El modelo es un árbol de grupos con condiciones y subgrupos, para soportar grupos anidados.

export type FilterField = "status" | "claimed" | "tags" | "initiative";
export type FilterOperator = { value: string; label: string; multiple?: boolean };
export type FilterOption = { value: string; label: string; status?: BoardStatus; chip?: boolean };
export type FilterJoin = "and" | "or";
export type FilterCondition = { id: string; join: FilterJoin; field: FilterField; operator: string; values: string[] };
export type FilterGroup = { id: string; join: FilterJoin; conditions: FilterCondition[]; groups: FilterGroup[] };
export type FilterMenuKind = "field" | "operator" | "value";
export type FilterMenuState = { rowId: string; kind: FilterMenuKind };
export type FilterMenuSnapshot = { kind: FilterMenuKind; options: FilterOption[]; selected: string[] };

// ─── Detalle de tarea ───────────────────────────────────────────────────────────────────────
// El detalle se proyecta del snapshot con `taskDetailFor()`. Los tipos viven acá y no en
// `data/` porque los componentes del detalle los consumen como props planas.

/** Una referencia del node, explícita o detectada en el texto. */
export type TaskReferenceKind = "doc" | "link" | "file";

export type TaskReference = {
  id: string;
  name: string;
  /** De dónde salió: `explicit`, `body`, `acceptance`, `notes`. */
  source: string;
  kind: TaskReferenceKind;
};

/** Un blocker entrante, con si ya está satisfecho. */
export type TaskBlocker = {
  id: string;
  title: string;
  kind: "task" | "gate" | "knowledge";
  status: BoardStatus;
  satisfied: boolean;
};

/** Un nodo que depende de éste. */
export type TaskDependent = {
  id: string;
  title: string;
  kind: "task" | "gate" | "knowledge";
  status: BoardStatus;
  edgeType: "BLOCKS" | "SUPERSEDES" | "DERIVED_FROM" | "INFORMS";
};

/** Knowledge aplicable a un node, con por qué aplica. */
export type TaskKnowledge = {
  id: string;
  title: string;
  body: string;
  knowledgeType: string;
  status: "active" | "deprecated" | "superseded";
  scopeMatches: string[];
};

/**
 * Qué dibuja `TaskActivityFeed` a la izquierda de una entrada.
 *
 * Es un discriminante y no un icono: guardar un asset de Hugeicons en los datos ataría el fixture a
 * una decisión visual, y cambiar el icono obligaría a tocar la tabla de datos. El componente decide.
 */
export type TaskActivityKind =
  | "created"
  | "comment"
  | "claim"
  | "release"
  | "submit"
  | "accept"
  | "reject"
  | "update"
  | "resolve"
  | "cancel"
  | "reopen"
  | "supersede"
  | "link";

export type TaskActivityEntry = {
  id: string;
  kind: TaskActivityKind;
  /** Agente o persona que firmó la acción. */
  author: string;
  /** Qué hizo, sin el nombre del autor: el componente antepone `author`. */
  text: string;
  /** Etiqueta corta ya formateada (`"3h"`, `"2d"`). */
  at: string;
  /** Sólo en `kind: "comment"`: el cuerpo del comentario, en su propia burbuja. */
  comment?: string;
};

/** Todo lo que necesita la vista de detalle de una tarea. */
export type TaskDetail = {
  task: Task;
  /** Párrafos del cuerpo (`body`), en orden. */
  body: string[];
  acceptance: string | null;
  initiative: string | null;
  domain: string | null;
  claimedBy: string | null;
  blockers: TaskBlocker[];
  dependents: TaskDependent[];
  knowledge: TaskKnowledge[];
  refs: TaskReference[];
  /** Hilo único del node: eventos del log y notas del thread, en orden cronológico. */
  activity: TaskActivityEntry[];
};

export type FilterFieldDef = {
  id: FilterField;
  label: string;
  icon: HugeIconAsset;
  operators: FilterOperator[];
  options: FilterOption[];
};
