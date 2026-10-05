/**
 * Timestamp ISO → `Mon D`, sin depender del locale.
 *
 * Está escrito a mano y no con `Intl` a propósito: `Intl` usa el locale del navegador, así que
 * la misma story renderizaría distinto en CI y en local. Un node sin actividad en el log
 * (`updatedAt === ""`) muestra un guion, no `undefined NaN`.
 */
export function formatUpdatedAt(value: string) {
  if (!value) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = Number(value.slice(5, 7)) - 1;
  const day = Number(value.slice(8, 10));
  if (!Number.isFinite(month) || !Number.isFinite(day) || month < 0 || month > 11) return "—";
  return `${months[month]} ${day}`;
}
