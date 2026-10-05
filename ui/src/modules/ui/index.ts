/**
 * API pública de `ui`: primitivas visuales.
 *
 * ### Por qué es un módulo aparte y no parte de `core`
 *
 * `core` es **infraestructura**: iconos, color, breakpoints, hooks. No tiene semántica visual.
 * `ui` es lo contrario: componentes con JSX, construidos sobre los tokens, sin una sola línea de
 * vocabulario de dominio. Un `Button` no sabe qué es una tarea; un `TaskListRow` sí.
 *
 * La separación importa por la dirección de las dependencias:
 *
 * ```text
 * pages ──▶ tasks ──┐
 *           app-shell ──▶ ui ──▶ core
 * ```
 *
 * `tasks` y `app-shell` pueden depender de `ui`, y **nunca** entre sí. Antes no existía ese lugar:
 * `SidebarRow` vivía dentro de `app-shell` y `PopoverSurface` dentro de `tasks`, así que una primitiva
 * de un dominio era inalcanzable para el otro sin un import cruzado.
 *
 * ### Reglas (las mismas que `core` y `tasks`)
 *
 *  - Exportar explícitamente, nunca `export *`.
 *  - Ningún tipo ni dato de dominio: si un primitivo necesita saber de tareas, está mal ubicado.
 *  - Toda primitiva tiene story, y la story es la documentación de sus variantes.
 */

export { Button } from "./components/Button";
export type { ButtonProps, ButtonState, ButtonVariant } from "./components/Button";

export { Chip } from "./components/Chip";
export type { ChipProps } from "./components/Chip";

export { MenuOption } from "./components/MenuOption";
export type { MenuOptionProps } from "./components/MenuOption";

export { PopoverSurface } from "./components/PopoverSurface";
export type { PopoverSurfaceProps, PopoverVariant } from "./components/PopoverSurface";
