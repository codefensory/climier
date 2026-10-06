/**
 * API pública de `tasks`.
 *
 * Reglas de este archivo (las mismas que `core`):
 *  - Exportar **explícitamente**, nunca `export *`: genera ciclos y rompe el HMR de
 *    `vite-plugin-solid`.
 *  - Exportar solo cosas puras (funciones, componentes) o reactivas (stores, accessors,
 *    controllers). Nunca valores derivados ya evaluados.
 *  - No re-exportar stories.
 */

// Componentes presentacionales
export { StatusGlyph } from "./components/StatusGlyph";
export type { KnowledgeLifecycleGlyph, StatusGlyphProps } from "./components/StatusGlyph";

export { TaskCounts } from "./components/TaskCounts";
export type { TaskCountsProps } from "./components/TaskCounts";

export { TaskTags } from "./components/TaskTags";
export type { TaskTagsProps } from "./components/TaskTags";

export { TaskMeta } from "./components/TaskMeta";
export type { TaskMetaProps } from "./components/TaskMeta";

export { TaskListRow } from "./components/TaskListRow";
export type { TaskListRowProps } from "./components/TaskListRow";

export { KanbanCard } from "./components/KanbanCard";
export type { KanbanCardProps } from "./components/KanbanCard";

export { GroupHeader } from "./components/GroupHeader";
export type { GroupHeaderProps } from "./components/GroupHeader";

export { GateRow } from "./components/GateRow";
export type { GateRowProps } from "./components/GateRow";

export { GateEgoPanel } from "./components/GateEgoPanel";
export type { GateEgoPanelProps } from "./components/GateEgoPanel";

export { GatesToolbar } from "./components/GatesToolbar";
export type { GateStatusOption, GatesToolbarProps } from "./components/GatesToolbar";

export { KnowledgeRow } from "./components/KnowledgeRow";
export type { KnowledgeRowProps } from "./components/KnowledgeRow";

export { KnowledgeEgoPanel } from "./components/KnowledgeEgoPanel";
export type { KnowledgeEgoPanelProps } from "./components/KnowledgeEgoPanel";

export { KnowledgesToolbar } from "./components/KnowledgesToolbar";
export type { KnowledgeStatusOption, KnowledgesToolbarProps } from "./components/KnowledgesToolbar";

export { TaskProperties } from "./components/TaskProperties";
export type { TaskPropertiesProps } from "./components/TaskProperties";

export { TaskActivityFeed } from "./components/TaskActivityFeed";
export type { TaskActivityFeedProps } from "./components/TaskActivityFeed";

export { TaskReferenceList } from "./components/TaskReferenceList";
export type { TaskReferenceListProps } from "./components/TaskReferenceList";

export { TaskCommentComposer } from "./components/TaskCommentComposer";
export type { TaskCommentComposerProps } from "./components/TaskCommentComposer";

export { TaskDetailView } from "./components/TaskDetailView";
export type { TaskDetailViewProps } from "./components/TaskDetailView";

export { TaskNotFound } from "./components/TaskNotFound";
export type { TaskNotFoundProps } from "./components/TaskNotFound";

export { FilterOptionContent } from "./components/FilterOptionContent";
export type { FilterOptionContentProps } from "./components/FilterOptionContent";

export { TaskListView } from "./components/TaskListView";
export type { TaskListViewProps } from "./components/TaskListView";

export { TaskKanbanView } from "./components/TaskKanbanView";
export type { TaskKanbanViewProps } from "./components/TaskKanbanView";

// Toolbar y sus menús
export { TasksToolbar } from "./components/TasksToolbar";
export type { TasksToolbarProps } from "./components/TasksToolbar";

export { TasksViewSwitch } from "./components/TasksViewSwitch";
export type { TasksViewSwitchProps } from "./components/TasksViewSwitch";

export { SortMenu } from "./components/SortMenu";
export type { SortMenuProps } from "./components/SortMenu";

export { GroupMenu } from "./components/GroupMenu";
export type { GroupMenuProps } from "./components/GroupMenu";

export { FilterPanel } from "./components/FilterPanel";
export type { FilterPanelProps } from "./components/FilterPanel";

// Contenedores
export { TaskBoardContainer } from "./containers/TaskBoardContainer";
export type { TaskBoardContainerProps } from "./containers/TaskBoardContainer";

// Controladores
export { useTaskFilters } from "./controllers/useTaskFilters";
export type { TaskFiltersController, UseTaskFiltersOptions } from "./controllers/useTaskFilters";

export { usePopoverMenu } from "./controllers/usePopoverMenu";
export type { UsePopoverMenuOptions } from "./controllers/usePopoverMenu";

export { useTasksUrl, DEFAULT_TASK_SORT } from "./controllers/useTasksUrl";
export type { TasksUrl } from "./controllers/useTasksUrl";

export { useGatesUrl } from "./controllers/useGatesUrl";
export { useKnowledgesUrl } from "./controllers/useKnowledgesUrl";

// Datos y vocabulario de dominio
export { STATUS_TOKENS, TASK_STATUSES, statusLabel, statusOrder } from "./data/statuses";
export { localAuthor, taskDetailFor } from "./data/taskDetail";
export { gatePurposeLabel, gatePurposeStyle } from "./data/gatePurposes";
export { knowledgeTypeLabel, knowledgeTypeStyle } from "./data/knowledgeTypes";
export { groupKnowledgeRecords, isKnowledgeStatus, knowledgeAxisLabel, knowledgeAxisName, knowledgeRegistrySummary, knowledgeStatusLabel, projectKnowledgeRegistry } from "./data/knowledges";
export type { KnowledgeAxis, KnowledgeAxisCoverage, KnowledgeGroupMode, KnowledgeReach, KnowledgeRecord, KnowledgeRegistryGroup, KnowledgeRegistrySummary } from "./data/knowledges";
export { taskTag, tagStyles } from "./data/tags";
export { blockedGateTaskCount, gateThreadCount, groupGateRecords, projectGateRegistry } from "./data/gates";
export type { GateGroupMode, GateRecord, GateRegistryGroup, GateRelation } from "./data/gates";
export { groupFields, sortFields } from "./data/sorting";
export { defaultFilterCondition, emptyFilterTree, filterFields } from "./data/filters";

// Proyección del snapshot (lo que consume `pages/`)
export {
  blockingForNode,
  boardTags,
  claimedAgents,
  dependentsForNode,
  derivedStatus,
  groupProgress,
  isSatisfied,
  knowledgeForNode,
  scopeMatches,
  projectBoard,
  projectGates,
  projectTaskDetail,
  projectTasks,
  refsOf,
  taskFromNode,
  taskProgress,
} from "./data/climier/projection";
export type {
  ClimierEdge,
  ClimierKnowledgeStatus,
  ClimierLogEntry,
  ClimierNode,
  ClimierNodeDetail,
  ClimierSnapshot,
} from "./data/climier/contract";

// Derivaciones puras
export { formatUpdatedAt } from "./utils/formatUpdatedAt";
export { sortedTasks } from "./utils/sortedTasks";
export { gateGroup, taskGroups } from "./utils/taskGroups";
export { filterTasks, hasActiveFilters } from "./utils/filterTasks";
export { decodeFilterTree, encodeFilterTree } from "./utils/filterTreeParam";
export { menuCoordinates } from "./utils/menuCoordinates";

export type {
  BoardStatus,
  FilterCondition,
  FilterField,
  FilterFieldDef,
  FilterGroup,
  FilterJoin,
  FilterMenuKind,
  FilterMenuSnapshot,
  FilterMenuState,
  FilterOperator,
  FilterOption,
  GateStatus,
  Task,
  TaskActivityEntry,
  TaskActivityKind,
  TaskBlocker,
  TaskDependent,
  TaskDetail,
  TaskFieldOption,
  TaskGroupBy,
  TaskGroupGlyph,
  TaskGroupView,
  TaskKnowledge,
  TaskReference,
  TaskReferenceKind,
  TaskSort,
  TaskSortKey,
  TaskScope,
  TaskScopeCounts,
  TaskStatus,
  TaskStatusOption,
  TaskTagStyle,
  TaskView,
} from "./types";
