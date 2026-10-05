import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { PopoverSurface } from "./PopoverSurface";
import type { PopoverSurfaceProps } from "./PopoverSurface";

/**
 * Superficie flotante: el wrapper que antes estaba escrito cuatro veces.
 *
 * Es la pieza que define la transición de entrada/salida, así que acá se ve el **estado cerrado**
 * sin trucos: sigue en el DOM con `invisible`, `inert` y `pointer-events-none` para que la salida se
 * pueda animar. Por eso los menús no se desmontan al cerrarse.
 *
 * `left`/`top` son valores planos a propósito: en la app los calcula `menuCoordinates`, pero acá se
 * fijan para poder comparar las dos variantes sin depender de un trigger.
 */
const meta = {
  title: "UI/PopoverSurface",
  component: PopoverSurface,
  parameters: { layout: "fullscreen" },
  argTypes: {
    variant: { control: "inline-radio", options: ["menuWide", "menuNarrow", "menuFit", "panel"] },
    open: { control: "boolean" },
    left: { control: { type: "number" } },
    top: { control: { type: "number" } },
    role: { control: "inline-radio", options: ["listbox", "dialog"] },
    label: { control: "text" },
    id: { control: "text" },
    testId: { control: "text" },
    filterOptionMenu: { control: "boolean" },
    children: { control: false },
  },
} satisfies Meta<typeof PopoverSurface>;

export default meta;

type Story = StoryObj<PopoverSurfaceProps>;

/** Tres filas con la forma de una opción de menú, para que se vea el ancho real. */
const Options = () => (
  <>
    {["Status", "Last updated", "Title"].map((label) => (
      <button type="button" role="option" aria-selected={label === "Status"} class="flex min-h-8 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12px] text-ink-soft transition hover:bg-canvas">
        <span class="flex h-5 w-5 shrink-0 items-center justify-center" />
        <span>{label}</span>
        <span class="ml-auto flex h-4 w-4 shrink-0 items-center justify-center text-tone-green-ink" />
      </button>
    ))}
  </>
);

/** Abierto: la transición ya terminó, el menú está en su posición final. */
export const OpenMenu: Story = {
  args: { variant: "menuWide", open: true, left: 80, top: 120, role: "listbox", label: "Sort by", id: "task-sort-menu", testId: "task-sort-menu" },
  render: (args) => <PopoverSurface {...args}><Options /></PopoverSurface>,
};

/**
 * Cerrado. Sigue en el DOM: `invisible` lo oculta sin sacarlo del árbol, `inert` lo saca del orden
 * de tabulación y `pointer-events-none` evita que intercepte clics. Los tres son necesarios — con
 * sólo `invisible` el menú sería alcanzable con Tab.
 */
export const ClosedMenu: Story = {
  args: { variant: "menuWide", open: false, left: 80, top: 120, role: "listbox", label: "Sort by", id: "task-sort-menu", testId: "task-sort-menu" },
  render: (args) => (
    <div class="p-4">
      <p class="text-[13px] text-muted">El menú está cerrado y no se ve: sigue en el DOM con `invisible`, `inert` y `pointer-events-none`.</p>
      <PopoverSurface {...args}><Options /></PopoverSurface>
    </div>
  ),
};

/**
 * La variante `panel`: más ancha, más redondeada, con más padding y en `z-[100]` para quedar **por
 * debajo** de los menús de opciones (`z-[110]`), que pueden abrirse dentro de ella.
 */
export const Panel: Story = {
  args: { variant: "panel", open: true, left: 80, top: 120, role: "dialog", label: "Task filters", id: "task-filter-panel", testId: "task-filter-panel" },
  render: (args) => (
    <PopoverSurface {...args}>
      <div class="mb-2 flex items-center justify-between"><h2 class="text-[13px] font-medium text-ink">Filters</h2></div>
      <div class="rounded-[8px] border border-line p-3 text-[12px] text-muted">Contenido del panel.</div>
    </PopoverSurface>
  ),
};

/**
 * Las cuatro variantes abiertas a la vez, para comparar tamaño y redondeo de un vistazo.
 *
 * Sólo se pueden ver juntas acá: en la app son mutuamente excluyentes por diseño, porque
 * `TasksToolbar` tiene un único signal con "cuál menú está abierto".
 */
export const AllVariants: Story = {
  render: () => (
    <div class="flex flex-wrap gap-6 p-4">
      {(["menuWide", "menuNarrow", "menuFit"] as const).map((variant, index) => (
        <div>
          <p class="mb-2 text-[11px] font-medium text-muted">{variant}</p>
          <PopoverSurface variant={variant} open left={12 + index * 20} top={60} role="listbox" label={variant} testId={`popover-${variant}`}>
            <Options />
          </PopoverSurface>
        </div>
      ))}
    </div>
  ),
};
