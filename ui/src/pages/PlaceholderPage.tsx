/**
 * Fallback visual para vistas sin contenido propio y rutas desconocidas.
 *
 * Knowledges y Gates ya cuentan con páginas propias; Initiatives y cualquier vista no registrada siguen
 * usando este frame vacío hasta que tengan contenido.
 */
import { PageFrame } from "./PageFrame";

export function PlaceholderPage() {
  return <PageFrame><div /></PageFrame>;
}
