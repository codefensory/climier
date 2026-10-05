import { createSignal, For } from "solid-js";
import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { appNavigation } from "../data/navigation";
import { NavGlyph } from "./NavGlyph";
import { SidebarRow } from "./SidebarRow";
import type { SidebarRowProps } from "./SidebarRow";
import { SidebarHeading } from "./SidebarHeading";

/**
 * Fila del sidebar. Presentacional puro: recibe valores planos, así que los Controls funcionan.
 *
 * Los cuatro estados reales son: inactivo, activo (`aria-current="page"`), hover, y el caso
 * `menu` con el menú abierto (`aria-expanded`). El hover sólo se ve con el puntero encima;
 * la story `States` muestra los otros tres lado a lado.
 */
const meta = {
  title: "AppShell/SidebarRow",
  component: SidebarRow,
  parameters: { layout: "centered" },
  argTypes: {
    label: { control: "text" },
    active: { control: "boolean" },
    nav: { control: "boolean" },
    menu: { control: "boolean" },
    expanded: { control: "boolean" },
    dataItem: { control: "text" },
    icon: { control: false },
    onSelect: { control: false },
  },
} satisfies Meta<typeof SidebarRow>;

export default meta;

/**
 * Los stories se tipan contra las props y no contra `typeof meta`: con `StoryObj<typeof meta>`
 * Storybook exige que *cada* story declare todos los `args` requeridos, incluso las que sólo
 * usan `render` y no leen ninguno.
 */
type Story = StoryObj<SidebarRowProps>;

/**
 * El icono se inyecta desde `render` y no desde `args` a propósito: en Solid un elemento JSX
 * creado en `args` se instancia una sola vez a nivel de módulo, y reutilizar el mismo nodo en
 * dos montajes es un bug. Todos los `render` lo crean fresco.
 */
const Frame = (props: { children: JSX.Element }) => (
  <div class="w-[248px] bg-canvas p-2">{props.children}</div>
);

export const Playground: Story = {
  args: {
    label: "Tasks",
    active: false,
    nav: true,
    onSelect: () => {},
  },
  render: (args) => (
    <Frame>
      <SidebarRow {...args} icon={<NavGlyph name="tasks" />} />
    </Frame>
  ),
};

/**
 * Los estados del sidebar de navegación. La fila activa es la única que cambia: borde, fondo
 * blanco, texto `ink` y una sombra de 1px.
 */
export const States: Story = {
  render: () => (
    <Frame>
      <SidebarHeading>Workspace</SidebarHeading>
      <SidebarRow nav label="Inactivo" active={false} onSelect={() => {}} icon={<NavGlyph name="tasks" />} />
      <SidebarRow nav label="Activo" active onSelect={() => {}} icon={<NavGlyph name="tasks" />} />
      <div class="py-2" />
      <SidebarHeading>Settings</SidebarHeading>
      <SidebarRow label="Inactivo (15px)" active={false} onSelect={() => {}} icon={<NavGlyph name="store" />} />
      <SidebarRow label="Activo (15px)" active onSelect={() => {}} icon={<NavGlyph name="store" />} />
    </Frame>
  ),
};

/**
 * La variante `menu`: en vez de navegar abre un menú, así que cambia `aria-current` por
 * `aria-haspopup` + `aria-expanded` y se pinta el fondo del chip al estar abierto.
 */
export const MenuTrigger: Story = {
  render: () => (
    <Frame>
      <SidebarRow menu expanded={false} label="Menú cerrado" active={false} onSelect={() => {}} icon={<NavGlyph name="store" />} />
      <SidebarRow menu expanded label="Menú abierto" active={false} onSelect={() => {}} icon={<NavGlyph name="store" />} />
    </Frame>
  ),
};

/**
 * Navegación real: demuestra que la reactividad de Solid sobrevive dentro de Storybook. Hacé
 * clic y la fila activa se mueve — el estado vive en la story, no en el componente.
 */
export const Interactive: Story = {
  render: () => {
    const [active, setActive] = createSignal("Tasks");
    return (
      <Frame>
        <SidebarHeading>Workspace</SidebarHeading>
        <For each={appNavigation}>
          {(item) => (
            <SidebarRow nav label={item.label} active={active() === item.label} onSelect={() => setActive(item.label)} icon={<NavGlyph name={item.icon} />} />
          )}
        </For>
      </Frame>
    );
  },
};
