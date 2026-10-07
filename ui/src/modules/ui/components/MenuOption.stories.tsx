import Layers01Icon from "@hugeicons/core-free-icons/Layers01Icon";
import Sorting01Icon from "@hugeicons/core-free-icons/Sorting01Icon";
import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HugeIcon } from "../../core";
import { Chip } from "./Chip";
import { MenuOption } from "./MenuOption";

/**
 * Fila de un menú: icono, etiqueta y el slot del check.
 *
 * Era la duplicación más grande del proyecto: cuatro copias en tres archivos, cada una con su versión
 * del slot del check. El primitivo se queda con lo idéntico (la fila y el check) y devuelve los dos
 * extremos, que sí son distintos:
 *
 * - `leading`: un icono envuelto en un cuadrado de 20px (Sort, Group), o un glyph de status (filtros).
 * - `label`: texto plano, o el contenido que decide entre glyph, chip y texto.
 *
 * Esta story no tiene `args` a propósito: `label` y `leading` son JSX, y **JSX en `args` es un bug en
 * Solid** — el elemento se instancia una sola vez a nivel de módulo y no se puede reutilizar entre
 * montajes. La consecuencia es que no hay panel de Controls; la tabla de estados está en la story.
 */
const meta = {
  title: "UI/MenuOption",
  component: MenuOption,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MenuOption>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

/**
 * El contenedor real de un menú.
 *
 * Lleva `role="listbox"` porque `MenuOption` renderiza `role="option"`, y un `option` **necesita** un
 * `listbox` o un `group` como padre (WCAG 2 A, 1.3.1). En la app ese padre lo pone `PopoverSurface`;
 * acá lo pone el scaffolding. Sin esto, las 5 stories fallan el chequeo de a11y — y estaba bien que
 * fallaran: el árbol de accesibilidad que armaba la story era inválido.
 */
const Menu = (props: { width?: string; children: JSX.Element }) => (
  <div role="listbox" aria-label="Opciones" class={`${props.width ?? "w-[220px]"} rounded-[10px] border border-line bg-surface p-1 shadow-[var(--elevation-overlay)]`}>{props.children}</div>
);

const Slot = (props: { icon: typeof Sorting01Icon }) => (
  <span class="flex h-5 w-5 shrink-0 items-center justify-center">
    <HugeIcon icon={props.icon} class="h-3.5 w-3.5" />
  </span>
);

/** Las dos formas reales: una lista con la opción elegida y otra sin ninguna. */
export const Playground: Story = {
  render: () => (
    <div class="flex flex-wrap gap-6 bg-surface p-6">
      <Menu>
        <MenuOption selected leading={<Slot icon={Sorting01Icon} />} onSelect={() => {}} label={<span>Status</span>} />
        <MenuOption selected={false} leading={<Slot icon={Sorting01Icon} />} onSelect={() => {}} label={<span>Last updated</span>} />
        <MenuOption selected={false} leading={<Slot icon={Layers01Icon} />} onSelect={() => {}} label={<span>Title</span>} />
      </Menu>
    </div>
  ),
};

/**
 * El check vive en el primitivo, no en el llamador.
 *
 * Es el slot que estaba copiado cuatro veces: un cuadrado de 16px alineado a la derecha que sólo se
 * llena cuando la opción está elegida. Si esto viviera en cada menú, uno de los cuatro dejaría de marcar.
 */
export const CheckSlot: Story = {
  render: () => (
    <div class="flex flex-wrap gap-6 bg-surface p-6">
      <Menu>
        {[true, false].map((selected) => (
          <MenuOption selected={selected} leading={<Slot icon={Sorting01Icon} />} onSelect={() => {}} label={<span>{selected ? "Elegida" : "No elegida"}</span>} />
        ))}
      </Menu>
    </div>
  ),
};

/** Sin `leading`: el menú de valores del filtro sólo pone un icono cuando el campo es un status. */
export const WithoutLeading: Story = {
  render: () => (
    <div class="flex flex-wrap gap-6 bg-surface p-6">
      <Menu width="w-[200px]">
        <MenuOption selected leading={undefined} onSelect={() => {}} label={<span>In Progress</span>} />
        <MenuOption selected={false} leading={undefined} onSelect={() => {}} label={<span>Ready</span>} />
        <MenuOption selected={false} leading={undefined} onSelect={() => {}} label={<span>Blocked</span>} />
      </Menu>
    </div>
  ),
};

/** Con un chip de label como etiqueta: el `label` acepta cualquier JSX, no sólo texto. */
export const ChipLabel: Story = {
  render: () => (
    <div class="flex flex-wrap gap-6 bg-surface p-6">
      <Menu>
        <MenuOption selected onSelect={() => {}} label={<Chip background="var(--color-tone-green-bg)" color="var(--color-tone-green-ink)">Design</Chip>} />
        <MenuOption selected={false} onSelect={() => {}} label={<Chip background="var(--color-tone-blue-bg)" color="var(--color-tone-blue-ink)">Platform</Chip>} />
        <MenuOption selected={false} onSelect={() => {}} label={<span>Billing</span>} />
      </Menu>
    </div>
  ),
};

/**
 * Etiqueta larga: la fila tiene `w-full` y la etiqueta trunca si hace falta, así que el check queda
 * siempre pegado al borde derecho.
 */
export const LongLabel: Story = {
  render: () => (
    <div class="flex flex-wrap gap-6 bg-surface p-6">
      <Menu>
        <MenuOption selected leading={<Slot icon={Layers01Icon} />} onSelect={() => {}} label={<span class="truncate">Infraestructura y despliegues de producción</span>} />
        <MenuOption selected={false} leading={<Slot icon={Layers01Icon} />} onSelect={() => {}} label={<span class="truncate">Corto</span>} />
      </Menu>
    </div>
  ),
};
