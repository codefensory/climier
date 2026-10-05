/**
 * Mezcla un color con transparencia.
 *
 * Antes esto era `hexToRgba(hex, alpha)`, que troceaba un string hex en JS y por eso no podía
 * aceptar `var(--color-…)`. Ahora la mezcla se delega al motor de CSS.
 *
 * `color-mix(in srgb, C 7%, transparent)` produce el mismo color que `rgba(r, g, b, 0.07)`:
 * la mezcla en sRGB es premultiplicada, así que mezclar con `transparent` solo cambia el alfa.
 * Verificado: `#667557 7%` → `color(srgb 0.4 0.458824 0.341176 / 0.07)`, y `0.4 × 255 = 102`,
 * `0.458824 × 255 = 117`, `0.341176 × 255 = 87`, que es el antiguo `rgba(102, 117, 87, 0.07)`.
 *
 * @param color Color de entrada, normalmente `var(--color-…)`.
 * @param alphaPercent Opacidad en porcentaje (0–100), no en fracción.
 */
export function tint(color: string, alphaPercent: number) {
  return `color-mix(in srgb, ${color} ${alphaPercent}%, transparent)`;
}
