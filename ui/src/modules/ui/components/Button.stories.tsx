import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button } from "./Button";
import type { ButtonProps } from "./Button";

/**
 * Botón.
 *
 * Las cinco variantes son **las recetas que ya existían**, y el orden de la cadena de clases es
 * deliberado: en el DOM medido, las clases del llamador van primero (para modificadores de layout como
 * `relative`), después la variante, y el estado al final.
 *
 * Las alturas **no** están normalizadas: `ghost` mide 32px y `segment` 28px, tal como estaban en el
 * código original. Unificarlas es un cambio visual, no un refactor; la tabla de variantes deja la
 * escala a la vista para poder decidirla con estas stories delante.
 */
const meta = {
  title: "UI/Button",
  component: Button,
  parameters: { layout: "fullscreen" },
  argTypes: {
    variant: { control: "inline-radio", options: ["ghost", "segment", "icon", "outline", "solid"] },
    state: { control: "inline-radio", options: ["idle", "open", "applied", "active"] },
    class: { control: "text" },
    children: { control: "text" },
  },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<ButtonProps>;

const Row = (props: { label: string; children: JSX.Element }) => (
  <div class="flex items-center gap-4">
    <span class="w-56 shrink-0 text-[11px] text-muted">{props.label}</span>
    {props.children}
  </div>
);

export const Playground: Story = {
  args: { variant: "ghost", children: "Sort" },
};

/** Las cinco variantes juntas. */
export const Variants: Story = {
  render: () => (
    <div class="space-y-4 bg-surface p-6">
      <Row label="ghost · disparador de toolbar">
        <Button variant="ghost">Sort</Button>
      </Row>
      <Row label="segment · List / Kanban">
        <Button variant="segment">List</Button>
      </Row>
      <Row label="icon · 28×28">
        <Button variant="icon" aria-label="Ejemplo">×</Button>
      </Row>
      <Row label="outline · acción de la vista">
        <Button variant="outline">This week</Button>
      </Row>
      <Row label="solid · acción principal">
        <Button variant="solid">Save</Button>
      </Row>
    </div>
  ),
};

/**
 * Los tres estados de `ghost`.
 *
 * Son tres cosas distintas: `open` es "el menú que abre está abierto", `applied` es "hay algo distinto
 * del valor por defecto", `idle` es el resto. El estado es del **control**, no del botón; por eso el
 * llamador decide cuál corresponde y el primitivo sólo tiene la tabla.
 */
export const GhostStates: Story = {
  render: () => (
    <div class="space-y-4 bg-surface p-6">
      <Row label="idle · sin nada aplicado">
        <Button variant="ghost">Sort</Button>
      </Row>
      <Row label="applied · orden distinto del default">
        <Button variant="ghost" state="applied">Sort</Button>
      </Row>
      <Row label="open · el menú está abierto">
        <Button variant="ghost" state="open">Sort</Button>
      </Row>
    </div>
  ),
};

/** Los dos estados de `segment`: el activo se pinta blanco con una sombra de 1px. */
export const SegmentStates: Story = {
  render: () => (
    <div class="space-y-4 bg-surface p-6">
      <Row label="control segmentado completo">
        <div class="flex shrink-0 items-center gap-[3px] rounded-[10px] bg-subtle p-[3px]">
          <Button variant="segment" state="active">List</Button>
          <Button variant="segment">Kanban</Button>
        </div>
      </Row>
      <Row label="el otro segmento activo">
        <div class="flex shrink-0 items-center gap-[3px] rounded-[10px] bg-subtle p-[3px]">
          <Button variant="segment">List</Button>
          <Button variant="segment" state="active">Kanban</Button>
        </div>
      </Row>
    </div>
  ),
};

/**
 * La prop `class` va **primero**, y existe para modificadores de layout.
 *
 * El disparador de filtros necesita `relative` porque adentro lleva el badge con la cuenta de
 * condiciones. Una prop `class` que se agregara al final no serviría para eso.
 */
export const ExtraClassFirst: Story = {
  render: () => (
    <div class="space-y-4 bg-surface p-6">
      <Row label="sin class extra">
        <Button variant="ghost">Filter</Button>
      </Row>
      <Row label='class="relative" + badge'>
        <Button variant="ghost" class="relative">
          Filter
          <span aria-hidden="true" class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-surface bg-muted px-1 text-[10px] font-semibold leading-none text-on-strong">2</span>
        </Button>
      </Row>
    </div>
  ),
};

/** Foco por teclado. `ghost` y `segment` usan `outline-offset-1`; `icon` y `outline`, `offset-2`. */
export const FocusRing: Story = {
  render: () => (
    <div class="space-y-4 bg-surface p-6">
      <p class="text-[12px] text-muted">Tabular para ver el anillo de foco de cada variante.</p>
      <Row label="ghost">
        <Button variant="ghost">Sort</Button>
      </Row>
      <Row label="segment">
        <Button variant="segment">List</Button>
      </Row>
      <Row label="icon">
        <Button variant="icon" aria-label="Ejemplo">×</Button>
      </Row>
      <Row label="outline">
        <Button variant="outline">This week</Button>
      </Row>
      <Row label="solid">
        <Button variant="solid">Save</Button>
      </Row>
    </div>
  ),
};

/** Deshabilitado, tal como lo usa `Clear all`: el primitivo no lo estiliza, lo estiliza el llamador. */
export const Disabled: Story = {
  render: () => (
    <div class="space-y-4 bg-surface p-6">
      <Row label="outline deshabilitado">
        <Button variant="outline" disabled>This week</Button>
      </Row>
      <Row label="solid deshabilitado">
        <Button variant="solid" disabled>Save</Button>
      </Row>
    </div>
  ),
};
