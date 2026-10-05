/**
 * Dos notas sobre accesibilidad, las dos encontradas por el chequeo de la Fase 7:
 *
 * - Los dos paneles de contenido **no** llevan `aria-label`. Lo llevaban, los dos, con el mismo nombre
 *   (`"Content panel"`), y eso los convertía en dos regiones con nombres idénticos: para un lector de
 *   pantalla eran la misma cosa dos veces, así que la etiqueta no distinguía nada. Un `<section>` sin
 *   nombre accesible no es un landmark, y eso es lo correcto para un esqueleto de relleno. Cuando cada
 *   panel tenga contenido de verdad le corresponde una etiqueta **distinta**, o mejor un
 *   `aria-labelledby` apuntando a su encabezado.
 * - El `<main>` no lleva `aria-label`, y acá eso importa: hay dos `<main>` en el frame (este y el de la
 *   vista activa) y sólo uno es visible por vez, porque el otro queda `aria-hidden` + `inert`. Los
 *   landmarks ocultos no cuentan para `landmark-unique`, así que los dos conviven sin violación.
 *
 * Vale la pena el detalle de por qué aparecieron recién ahora: cinco fases de diff de DOM no podían
 * verlos. Un diff verifica que las cosas sean **iguales**, no que estén **bien**.
 *
 * Settings: el segundo `<main>` del frame.
 *
 * No entra en el switch de vistas: está siempre montado y se muestra u oculta con `settingsOpen()`, porque
 * la transición de `main-content-view` necesita que los dos `<main>` existan a la vez. Tampoco lee
 * `activeView()` — el `activeView` de atrás sigue vivo mientras settings está abierto, y por eso al cerrarlo
 * se vuelve a la vista donde estabas.
 */
import { useShell } from "../modules/app-shell";
import { Button } from "../modules/ui";

export function SettingsPage() {
  const { settingsOpen } = useShell();
  return (
    <main data-testid="settings-content" classList={{ "main-content-view": true, "main-content-visible": settingsOpen() }} aria-hidden={!settingsOpen()} inert={!settingsOpen()} class="min-w-0 bg-white px-6 py-7 sm:px-8 lg:px-10">
              <div class="mx-auto w-full max-w-[1100px]">
                <div class="mb-4 flex justify-end">
                  <Button variant="solid">Save</Button>
                </div>
                <div class="grid gap-4 md:grid-cols-2">
                  <section class="min-h-[230px] rounded-[12px] border border-line bg-white p-5"><div class="h-4 w-32 rounded bg-chip" /><div class="mt-6 h-3 w-full max-w-[340px] rounded bg-skeleton" /><div class="mt-3 h-3 w-3/4 rounded bg-skeleton" /></section>
                  <section class="min-h-[230px] rounded-[12px] border border-line bg-white p-5"><div class="h-4 w-24 rounded bg-chip" /><div class="mt-6 h-3 w-full max-w-[300px] rounded bg-skeleton" /><div class="mt-3 h-3 w-2/3 rounded bg-skeleton" /></section>
                </div>
              </div>
            </main>
  );
}
