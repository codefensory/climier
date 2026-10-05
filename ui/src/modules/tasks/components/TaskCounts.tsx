import Comment01Icon from "@hugeicons/core-free-icons/Comment01Icon";
import GitBranchIcon from "@hugeicons/core-free-icons/GitBranchIcon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import LockIcon from "@hugeicons/core-free-icons/LockIcon";
import { HugeIcon } from "../../core";
import type { Task } from "../types";

export type TaskCountsProps = { task: Task };

/**
 * Contadores del DAG: notas, referencias, blockers sin satisfacer y dependents.
 *
 * Cada uno lleva su `aria-label` porque un número suelto no dice de qué es: sin él, un lector de
 * pantalla anuncia "4 2 3".
 *
 * Los blockers muestran sólo los **no satisfechos** (lo que realmente frena la task); los
 * dependents cuentan todas las salidas (`BLOCKS`, `SUPERSEDES`, `DERIVED_FROM`).
 */
export function TaskCounts(props: TaskCountsProps) {
  return (
    <div class="flex shrink-0 items-center gap-2.5 text-[11px] tabular-nums text-muted">
      <span class="flex items-center gap-1" aria-label={`${props.task.notes} notes`}><HugeIcon icon={Comment01Icon} class="h-3.5 w-3.5" strokeWidth="1.4" />{props.task.notes}</span>
      <span class="flex items-center gap-1" aria-label={`${props.task.refs} references`}><HugeIcon icon={Link01Icon} class="h-3.5 w-3.5" strokeWidth="1.4" />{props.task.refs}</span>
      <span class="flex items-center gap-1" aria-label={`${props.task.blockers} blockers`}><HugeIcon icon={LockIcon} class="h-3.5 w-3.5" strokeWidth="1.4" />{props.task.blockers}</span>
      <span class="flex items-center gap-1" aria-label={`${props.task.dependents} dependents`}><HugeIcon icon={GitBranchIcon} class="h-3.5 w-3.5" strokeWidth="1.4" />{props.task.dependents}</span>
    </div>
  );
}
