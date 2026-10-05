import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import HashIcon from "@hugeicons/core-free-icons/HashIcon";
import MinusSignIcon from "@hugeicons/core-free-icons/MinusSignIcon";
import Rocket01Icon from "@hugeicons/core-free-icons/Rocket01Icon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import TextFontIcon from "@hugeicons/core-free-icons/TextFontIcon";
import type { TaskFieldOption, TaskGroupBy, TaskSortKey } from "../types";

/** Criterios de orden del menú de sort. */
export const sortFields: TaskFieldOption<TaskSortKey>[] = [
  { key: "updated", label: "Last activity", icon: Clock01Icon },
  { key: "title", label: "Title", icon: TextFontIcon },
  { key: "id", label: "Task ID", icon: HashIcon },
  { key: "status", label: "Status", icon: Task01Icon },
  { key: "initiative", label: "Initiative", icon: Rocket01Icon },
];

/** Criterios de agrupación del menú de group. `none` deja una sola lista. */
export const groupFields: TaskFieldOption<TaskGroupBy>[] = [
  { key: "status", label: "Status", icon: Task01Icon },
  { key: "tags", label: "Tags", icon: BookOpen01Icon },
  { key: "initiative", label: "Initiative", icon: Rocket01Icon },
  { key: "none", label: "None", icon: MinusSignIcon },
];
