/**
 * API pública de `core`.
 *
 * Reglas de este archivo:
 *  - Exportar **explícitamente**, nunca `export *`: genera ciclos y rompe el HMR de
 *    `vite-plugin-solid`.
 *  - Exportar solo cosas puras (funciones, componentes) o reactivas (stores, accessors,
 *    primitives). Nunca valores derivados ya evaluados.
 *  - No re-exportar stories.
 *  - `core` no conoce datos de la aplicación: aquí va infraestructura compartida, no
 *    vocabulario de dominio ni configuración de navegación.
 */

export { HugeIcon } from "./components/HugeIcon";
export type { HugeIconProps } from "./components/HugeIcon";

export type { HugeIconAsset } from "./types/hugeicon";

export { tint } from "./utils/color";

export { BREAKPOINTS } from "./breakpoints";
export { useMediaQuery } from "./primitives/useMediaQuery";
