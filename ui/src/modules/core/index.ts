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

export { parseInline, parseMarkdown } from "./utils/markdown";
export type { MarkdownBlock, MarkdownInline } from "./utils/markdown";

export { BREAKPOINTS } from "./breakpoints";
export { useMediaQuery } from "./primitives/useMediaQuery";

export { backoffDelay, waitForBackoff } from "./http/backoff";
export type { BackoffOptions } from "./http/backoff";
export { createHttpClient, HttpError } from "./http/client";
export type { FetchLike, HttpClientOptions, StorageLike } from "./http/client";
export { createSseParser, consumeSse } from "./http/sse";
export type { SseMessage } from "./http/sse";
export { AUTH_STORAGE_KEY, PROTOCOL_HEADER, PROTOCOL_VERSION } from "./http/protocol";
export type { ProjectSummary, SnapshotResponse } from "./http/protocol";
export { RuntimeProvider, useRuntime } from "./providers/RuntimeProvider";
export type { RuntimeController, RuntimeMode } from "./providers/RuntimeProvider";
export { SessionProvider, useSession } from "./providers/SessionProvider";
export type { SessionController } from "./providers/SessionProvider";
