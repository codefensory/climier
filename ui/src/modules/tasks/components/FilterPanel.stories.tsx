import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { isSurfaceOpen, must } from "../../../test-utils/story";

import { useTaskFilters } from "../controllers/useTaskFilters";
import { emptyFilterTree } from "../data/filters";
import { snapshot } from "../data/source";
import { makeCondition, makeFilterTree } from "../data/fixtures";
import { FilterPanel } from "./FilterPanel";
import type { FilterGroup } from "../types";

/**
 * Botón de filtro + panel con el árbol de condiciones + menú de opciones de una fila.
 *
 * El estado del árbol es el más enredado de la toolbar: grupos con condiciones, subgrupos de un solo
 * nivel, y conectores `And`/`Or` que se pueden cambiar por fila. Mostrarlo con `args` sería imposible
 * —son 6 estados anidados— así que el `Host` le siembra un árbol con `makeFilterTree()` en vez de simular
 * clicks: en la app el árbol viene de la URL, y acá de un signal local, pero el controlador es el mismo.
 *
 * El menú de opciones **no** se cierra al elegir un valor cuando el operador es múltiple (`is any of`):
 * filtrar por varios valores es una sola decisión, no varias.
 */
const meta = {
  title: "Tasks/FilterPanel",
  component: FilterPanel,
  parameters: { layout: "fullscreen" },
  argTypes: {
    filters: { control: false },
    isOpen: { control: false },
    setOpen: { control: false },
  },
} satisfies Meta<typeof FilterPanel>;

export default meta;

type Story = StoryObj<Record<string, unknown>>;

/**
 * Monta el panel con su controlador.
 *
 * Para mostrarlo abierto hay que clickear el trigger: la posición del panel se calcula midiendo el
 * trigger. `useTaskFilters` sí acepta el árbol inicial, así que los estados de contenido no necesitan
 * interacción.
 */
const Host = (props: { tree?: FilterGroup; note?: string }) => {
  const [open, setOpen] = createSignal(false);
  // El árbol es controlado: en la app es la URL, acá un signal local. Mismo contrato, distinto dueño.
  const [tree, setTree] = createSignal<FilterGroup>(props.tree ?? emptyFilterTree());
  const filters = useTaskFilters({ isOpen: open, setOpen, tree, setTree, snapshot: () => snapshot });
  return (
    <div class="bg-surface p-4">
      {props.note && <p class="mb-3 text-[12px] text-muted">{props.note}</p>}
      <div class="flex justify-end">
        <FilterPanel filters={filters} isOpen={open} setOpen={setOpen} />
      </div>
    </div>
  );
};

/**
 * Abre el panel con un click real y verifica que quedó abierto.
 *
 * El árbol de condiciones se pasa por `initialTree` (no es una interacción), pero **abrir el panel sí lo
 * es**: la posición se calcula midiendo el trigger, así que no se puede inyectar desde afuera.
 */
const openPanel = async () => {
  await userEvent.click(must(document.querySelector('[aria-label="Filter"]'), "el botón de Filter"));
  await waitFor(() => expect(isSurfaceOpen("task-filter-panel")).toBe(true));
};

/** Cerrado, sin condiciones: el botón no tiene badge. */
export const Closed: Story = {
  render: () => <Host />,
};

/** Abierto y vacío: el panel explica qué hacer y `Clear all` está deshabilitado. */
export const OpenEmpty: Story = {
  render: () => <Host note="Panel abierto sin condiciones. `Clear all` queda deshabilitado porque no hay nada que limpiar." />,
};

/** Una condición: el caso más común. Sin conector, porque el conector aparece desde la segunda fila. */
export const OneCondition: Story = {
  render: () => <Host tree={makeFilterTree({ conditions: [makeCondition("condition-1")] })} />,
  play: openPanel,
};

/**
 * Tres condiciones con campos distintos.
 *
 * Las tres formas de mostrar un valor conviven: `status` con su hexágono, `tags` con el chip, y
 * `claimed`/`initiative` con el icono y el texto. Y los conectores `And` se pueden clickear para
 * pasar a `Or` por fila.
 */
export const MultipleConditions: Story = {
  render: () => (
    <Host
      tree={makeFilterTree({
        conditions: [
          makeCondition("condition-1", { field: "status", operator: "is", values: ["in_progress"] }),
          makeCondition("condition-2", { field: "tags", operator: "is", values: ["design"] }),
          makeCondition("condition-3", { field: "claimed", operator: "is", values: ["Unassigned"] }),
        ],
      })}
    />
  ),
  play: openPanel,
};

/**
 * Un campo con operador múltiple: `is any of` con dos labels.
 *
 * Acá es donde se ve el `+N`: la fila muestra el primer valor y cuenta el resto, porque no entra todo.
 */
export const MultipleValues: Story = {
  render: () => (
    <Host
      tree={makeFilterTree({
        conditions: [makeCondition("condition-1", { field: "tags", operator: "any", values: ["design", "platform"] })],
      })}
    />
  ),
  play: openPanel,
};

/**
 * Un subgrupo. `Add group` sólo está disponible sobre el grupo raíz y **sólo un nivel**: si ya hay un
 * subgrupo, la opción desaparece. Anidar más profundo haría ilegible el panel y no hay caso de uso.
 *
 * El grupo es `Or` y la raíz `And`, así que la lectura es `(A) AND (B OR C)`. El badge del trigger
 * cuenta las 3 condiciones, incluidas las de adentro del subgrupo.
 */
export const WithSubgroup: Story = {
  render: () => (
    <Host
      tree={makeFilterTree({
        conditions: [makeCondition("condition-1", { field: "status", operator: "is", values: ["blocked"] })],
        groups: [{
          id: "group-1",
          join: "or",
          conditions: [
            makeCondition("condition-2", { field: "tags", operator: "is", values: ["design"] }),
            makeCondition("condition-3", { field: "claimed", operator: "is", values: ["climier-worker"], join: "or" }),
          ],
          groups: [],
        }],
      })}
    />
  ),
  play: openPanel,
};

/** 5 condiciones: el badge del trigger pasa a dos dígitos y el panel empieza a scrollear. */
export const ManyConditions: Story = {
  render: () => (
    <Host
      tree={makeFilterTree({
        conditions: [
          makeCondition("condition-1", { field: "status", operator: "is", values: ["blocked"] }),
          makeCondition("condition-2", { field: "tags", operator: "is", values: ["design"] }),
          makeCondition("condition-3", { field: "claimed", operator: "is-not", values: ["climier-worker-2"] }),
          makeCondition("condition-4", { field: "initiative", operator: "any", values: ["checkout", "platform"] }),
          makeCondition("condition-5", { field: "status", operator: "none", values: ["done"], join: "or" }),
        ],
      })}
    />
  ),
  play: openPanel,
};

/** Interactivo: agregar una fila, cambiar el campo, elegir un valor y borrar. */
export const Interactive: Story = {
  render: () => (
    <Host
      note="Clic en Filter para abrir. `Add filter` agrega una fila; los tres botones de la fila abren sus menús; la × la borra."
    />
  ),
};

/** Angosto: los conectores se acortan (`max-[639px]:w-8`) para que la fila siga entrando. */
export const Narrow: Story = {
  globals: { viewport: { value: "narrow" } },
  render: () => <Host tree={makeFilterTree({ conditions: [makeCondition("condition-1"), makeCondition("condition-2", { field: "tags", operator: "is", values: ["design"] })] })} />,
  play: openPanel,
};
