/**
 * Posición de un menú flotante anclado a su trigger.
 *
 * Abre debajo del trigger; si no entra en el viewport, abre **arriba**. Y siempre clampa en
 * horizontal, así que un trigger pegado al borde derecho no empuja el menú fuera de pantalla.
 *
 * El `height` es el alto estimado del menú y no el real: se calcula antes de abrirlo, cuando el
 * elemento todavía no se midió. Por eso los call sites pasan una constante y por eso el menú tiene
 * `max-h` — si el contenido crece más que la estimación, la decisión de abrir arriba puede quedar
 * corta.
 */
export function menuCoordinates(trigger: HTMLButtonElement, width: number, height: number) {
  const rect = trigger.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const below = rect.bottom + 6;
  const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 6);
  return { left, top };
}
