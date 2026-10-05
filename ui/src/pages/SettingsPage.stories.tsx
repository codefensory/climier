import { onMount } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { useShell } from "../modules/app-shell";
import { SettingsPage } from "./SettingsPage";
import { StoryShell } from "../test-utils/StoryShell";

/**
 * Settings: el segundo `<main>` del frame.
 *
 * No entra en el switch de vistas. Está siempre montado y se muestra u oculta con `settingsOpen()`,
 * porque la transición de `main-content-view` necesita que los dos `<main>` existan a la vez — si se
 * desmontara no habría nada que animar y el panel aparecería de golpe.
 *
 * Tampoco lee `activeView()`: mientras settings está abierto, la vista de atrás sigue seleccionada, y por
 * eso al cerrarlo se vuelve donde estabas. En la app real esa vista sigue montada detrás (con
 * `aria-hidden` e `inert`), así que no pierde su estado.
 */
const meta = {
  title: "Pages/SettingsPage",
  component: SettingsPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SettingsPage>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

/**
 * Monta el panel y lo abre.
 *
 * Hace falta abrirlo porque con `settingsOpen()` en false el `<main>` queda en `visibility: hidden`,
 * `opacity: 0`: la story se vería vacía. `selectBottomNavItem` es la misma acción que dispara el item
 * "Settings" del sidebar, así que esto es literalmente "entrar a settings".
 *
 * Esto **no** es un `play`, a propósito: no simula una acción del usuario, siembra el estado del shell.
 * No hay nada que clickear porque la story monta la página sola, sin sidebar. La interacción real de
 * entrar a settings desde el sidebar se prueba en `App.stories.tsx > SettingsFlow`.
 *
 * Monta el panel y lo abre. Hace falta `StoryShell` porque `useShell()` deriva la vista activa y el panel
 * de settings de la URL: sin router, `useLocation()` no tiene contexto. La story reemplaza a `App`, así
 * que declara el router por fuera; la URL arranca en `/` y después el `onMount` abre el panel con
 * `?panel=settings`, que es exactamente lo que hace el sidebar.
 *
 * El contenedor es `.main-content-frame`, la clase real del proyecto: es la misma caja contenedora que la
 * página tiene en la app (`.main-content-view` es `position: absolute` con `inset: 44px 8px 8px`, y ese
 * `relative` lo aporta el frame). Usar la clase real y no un `min-h-[620px]` suelto evita depender de que
 * Tailwind haya escaneado este archivo: una clase que sólo existe en una story puede no estar generada
 * todavía si el dev server arrancó antes de que el archivo existiera.
 */
const Host = () => {
  const { selectBottomNavItem } = useShell();
  onMount(() => selectBottomNavItem({ label: "Settings", icon: "settings" }));
  return (
    <div class="main-content-frame">
      <SettingsPage />
    </div>
  );
};

export const Playground: Story = {
  render: () => (
    <StoryShell shell>
      <Host />
    </StoryShell>
  ),
};

export const Wide: Story = {
  globals: { viewport: { value: "wide" } },
  render: () => (
    <StoryShell shell>
      <Host />
    </StoryShell>
  ),
};

/**
 * Los dos paneles internos pasan a una columna por debajo de `md` (768px) — otro breakpoint de Tailwind,
 * distinto otra vez de los de la app.
 */
export const Narrow: Story = {
  globals: { viewport: { value: "narrow" } },
  render: () => (
    <StoryShell shell>
      <Host />
    </StoryShell>
  ),
};
