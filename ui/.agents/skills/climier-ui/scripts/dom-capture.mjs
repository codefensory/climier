/**
 * Captura de DOM + colores computados de la app, para comparar antes/después de un refactor.
 *
 * Uso (desde la raíz del repo, con Storybook corriendo):
 *
 *     bun run storybook &                      # o scripts/dev.sh start storybook
 *     DOM_OUT=dom/after.txt ego-browser < .agents/skills/climier-ui/scripts/dom-capture.mjs
 *     node .agents/skills/climier-ui/scripts/normdom.mjs dom/before.txt dom/after.txt
 *
 * Este archivo **no** es un módulo de Node: se le pasa a `ego-browser` por stdin, así que corre dentro del
 * runner de ego-browser (donde `process` existe pero `fs` **no**: hay que importarlo). Dos consecuencias:
 *
 *  - No puede importar nada del repo. Es deliberadamente autocontenido.
 *  - No lo cubre ningún `tsconfig` ni lint. Se valida corriéndolo.
 *
 * ### Por qué existe
 *
 * El arnés de tests (stories con `play` y axe) verifica *comportamiento*. No verifica que el render sea
 * el mismo: un refactor puede mover un `<div>`, perder una clase de Tailwind o cambiar un token de color sin
 * que ninguna aserción se entere. Esto compara el markup renderizado y el color computado de cada elemento
 * pintado, así que una diferencia de un solo atributo aparece.
 *
 * ### Por qué cada captura recarga la story
 *
 * El estado de la app vive en la URL y en la vista de Storybook, y **sobrevive entre capturas**: si las
 * capturas se encadenaran (abrir un menú, navegar, volver) cada una dependería de las anteriores y el orden
 * sería parte del resultado. Cada captura hace `goto` y arranca limpia, así que son independientes.
 *
 * Ver `references/dom-harness.md` para el formato del archivo y cómo se decide el veredicto.
 */
// `node:fs/promises` y no `node:fs`: la API de callbacks no acepta `writeFile(path, texto)` sin callback.
const fs = await import("node:fs/promises");

const BASE = process.env.SB_URL ?? "http://127.0.0.1:6006";
/** Cualquier story que monte `<App/>` sirve: la app arma su propio router. */
const STORY = process.env.DOM_STORY ?? "app--wide";
/** Ancho del viewport. 1440 es el layout de escritorio; los breakpoints de la app son 639 y 1023. */
const WIDTH = Number(process.env.DOM_WIDTH ?? 1440);
const HEIGHT = Number(process.env.DOM_HEIGHT ?? 900);
const OUT = process.env.DOM_OUT ?? "dom/current.txt";

/**
 * Capturas: nombre y pasos. Los pasos se aplican en orden, sobre una story recién cargada.
 *
 * `nav` es un item del sidebar, `click` un selector CSS, `text` un botón por su texto (opcionalmente
 * acotado a `within`), `option` una opción de un menú portaleado, `back` el "Back to app" de settings.
 *
 * **Las opciones tienen que existir.** Si alguien renombra un item de menú, el paso falla con la lista de las
 * que hay (`no existe la opción "X" (hay: …)`), que es la señal de que la lista de capturas quedó vieja. Es a
 * propósito: el arnés compara estados, así que un estado que ya no se puede alcanzar tiene que doler.
 */
const CAPTURES = [
  { name: "Home", steps: [] },
  { name: "Tasks-list", steps: [{ nav: "Tasks" }] },
  { name: "Tasks-kanban", steps: [{ nav: "Tasks" }, { pick: { testid: "tasks-view-switch", text: "Kanban" } }] },
  { name: "Tasks-sort-menu", steps: [{ nav: "Tasks" }, { click: "[data-sort-trigger]" }] },
  { name: "Tasks-group-menu", steps: [{ nav: "Tasks" }, { click: "[data-group-trigger]" }] },
  { name: "Tasks-filter-panel", steps: [{ nav: "Tasks" }, { click: '[aria-label="Filter"]' }] },
  { name: "Tasks-sort-status", steps: [{ nav: "Tasks" }, { click: "[data-sort-trigger]" }, { option: { surface: "Sort by", label: "Status" } }] },
  { name: "Tasks-group-labels", steps: [{ nav: "Tasks" }, { click: "[data-group-trigger]" }, { option: { surface: "Group by", label: "Labels" } }] },
  { name: "Tasks-filter-condition", steps: [{ nav: "Tasks" }, { click: '[aria-label="Filter"]' }, { text: "Add filter", within: '[data-testid="task-filter-panel"]' }] },
  { name: "Knowledges", steps: [{ nav: "Knowledges" }] },
  { name: "Gates", steps: [{ nav: "Gates" }] },
  { name: "Initiatives", steps: [{ nav: "Initiatives" }] },
  { name: "Account", steps: [{ nav: "Account" }] },
  { name: "Settings", steps: [{ nav: "Settings" }] },
  { name: "Settings-back", steps: [{ nav: "Settings" }, { back: true }] },
];

// ── Helpers de interacción (con nombres que no chocan con el scope del runner) ────────────────────
// El runner ya declara `click`, `page`, `task`, `fs`, …: declarar `const click` en el nivel de arriba tira
// `SyntaxError: Identifier 'click' has already been declared` y el script no corre. De ahí los prefijos.

const stepClick = (selector, label) => page.click(`loc=css:${selector}`, { label: label ?? selector });

const stepClickRole = (name) => page.click(`loc=role:button[name="${name}"]`, { label: `click ${name}` });

/** Click por texto, opcionalmente dentro de un contenedor. Devuelve el texto del botón para el log. */
const stepClickText = async (text, within) => {
  const hit = await page.evaluate(
    ([wanted, scope]) => {
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return `no existe el contenedor ${scope}`;
      const button = [...root.querySelectorAll("button")].find((item) => item.textContent.trim() === wanted);
      if (!button) return `no existe el botón "${wanted}"`;
      button.click();
      return `click en "${wanted}"`;
    },
    [text, within ?? null],
  );
  if (hit.startsWith("no existe")) throw new Error(hit);
  return hit;
};

/**
 * Elige una opción de un menú portaleado.
 *
 * Las cinco superficies están **siempre** en el DOM (las cerradas con `invisible`), así que buscar
 * `role=option[name="Priority"]` a secas matchearía la del menú de sort aunque esté cerrada. Hay que acotar
 * por el `aria-label` de la superficie.
 */
const stepOption = async (surface, label) => {
  const hit = await page.evaluate(
    ([surfaceName, wanted]) => {
      const root = document.querySelector(`[aria-label="${surfaceName}"]`);
      if (!root) return `no existe la superficie "${surfaceName}"`;
      const option = [...root.querySelectorAll('[role="option"]')].find((item) => item.textContent.trim() === wanted);
      if (!option) {
        const available = [...root.querySelectorAll('[role="option"]')].map((item) => item.textContent.trim()).join(", ");
        return `no existe la opción "${wanted}" (hay: ${available})`;
      }
      const already = option.getAttribute("aria-selected") === "true" ? " (ya estaba marcada)" : "";
      option.click();
      return `click en "${wanted}"${already}`;
    },
    [surface, label],
  );
  if (hit.startsWith("no existe")) throw new Error(hit);
  return hit;
};

const runStep = async (step) => {
  if (step.nav) return stepClickRole(step.nav);
  if (step.click) return stepClick(step.click);
  if (step.text) return stepClickText(step.text, step.within);
  if (step.option) return stepOption(step.option.surface, step.option.label);
  if (step.pick) return stepClickText(step.pick.text, `[data-testid="${step.pick.testid}"]`);
  if (step.back) return stepClickRole("Back to app");
  throw new Error(`paso desconocido: ${JSON.stringify(step)}`);
};

// ── Captura ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Lee el estado actual de la página.
 *
 *  - `roots`: los hijos de `<body>` que son de la app. Se excluye el chrome de Storybook por estructura
 *    (`sb-*` y los `storybook-*`), no por tamaño: el contenedor del Portal mide 1440×0 y **contiene** los menús
 *    abiertos, así que una regla de "tamaño > 0" se llevaría puesto justo lo que hay que capturar.
 *
 *    Cuidado con el filtro: `#storybook-root` empieza con `storybook-` pero **es la app**. Un `startsWith`
 *    sin la excepción deja el arnés comparando sólo los portaleados —y diciendo IDÉNTICO para siempre, que es
 *    peor que fallar: da confianza falsa. Estuvo así y se detectó inyectando una diferencia a propósito (ver
 *    `references/dom-harness.md`). Por eso además hay una guardia que verifica que la raíz exista y tenga
 *    contenido.
 *  - Colores: `getComputedStyle` de cada elemento pintado. Es lo que detecta un cambio de token que no
 *    cambia el markup.
 *  - Guardia de error: si la superposición de error de Storybook está visible, la captura falla en vez de
 *    guardar un archivo que parecería correcto.
 */
const readState = () =>
  page.evaluate(() => {
    const isChrome = (el) => {
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "META") return true;
      if ((el.className?.toString?.() ?? "").split(/\s+/).some((name) => name.startsWith("sb-"))) return true;
      // Todos los `storybook-*` son chrome… menos `storybook-root`, que es donde monta la app.
      return el.id.startsWith("storybook-") && el.id !== "storybook-root";
    };

    const error = document.querySelector(".sb-errordisplay");
    if (error && getComputedStyle(error).display !== "none") {
      return { error: (error.textContent ?? "").slice(0, 400) || "la story falló" };
    }

    // Guardia: sin raíz no hay nada que comparar. Sin esto, un filtro demasiado agresivo devuelve un archivo
    // de capturas que compara cuatro divs y dice IDÉNTICO en todas las corridas.
    const appRoot = document.getElementById("storybook-root");
    if (!appRoot || appRoot.children.length === 0) {
      return { error: "#storybook-root no existe o está vacío: la story no montó la app" };
    }

    const roots = [...document.body.children].filter((el) => !isChrome(el));

    const elements = [...document.querySelectorAll("*")];
    const painted = elements.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    const COLOR_PROPS = ["color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "fill", "stroke", "stroke-width"];
    const colorLines = painted.map((el) => {
      const style = getComputedStyle(el);
      const props = COLOR_PROPS.map((prop) => `${prop}:${style.getPropertyValue(prop)}`).join(" ");
      return `${el.tagName}|${props}`;
    });

    return {
      metrics: {
        width: window.innerWidth,
        height: window.innerHeight,
        elements: elements.length,
        painted: painted.length,
        svgs: document.querySelectorAll("svg").length,
        bodyChildren: roots.length,
        hash: window.location.hash || "(vacío)",
      },
      /** El markup de la app, sin el chrome de Storybook. Se normaliza al comparar, no acá. */
      dom: roots.map((el) => el.outerHTML).join("\n"),
      colors: colorLines.join("\n"),
    };
  });

const blocks = [];
const capture = async (name, steps) => {
  await page.goto(`${BASE}/iframe.html?id=${STORY}&viewMode=story`);
  await page.waitForSelector('[data-testid="dashboard-layout"]', { timeout: 15000 });
  await page.waitForTimeout(400);

  for (const step of steps) await runStep(step);
  if (steps.length) await page.waitForTimeout(500);

  const state = await readState();
  if (state.error) throw new Error(`la captura "${name}" falló: ${state.error}`);

  const { metrics, dom, colors } = state;
  blocks.push(
    [
      `########## ${name}`,
      `-- metrics width=${metrics.width} height=${metrics.height} elements=${metrics.elements} painted=${metrics.painted} svgs=${metrics.svgs} bodyChildren=${metrics.bodyChildren} hash=${metrics.hash}`,
      `-- colors`,
      colors,
      `-- dom`,
      dom,
    ].join("\n"),
  );
  console.log(`  ${name.padEnd(24)} elements=${String(metrics.elements).padStart(4)} painted=${String(metrics.painted).padStart(4)} svgs=${String(metrics.svgs).padStart(3)} hash=${metrics.hash}`);
};

const task = await taskSpace("climier-ui dom harness");
const page = task.page("p1");
// El tamaño se fija por CDP: sin esto la captura depende del tamaño con que haya arrancado el daemon, y dos
// corridas darían hashes distintos por una razón que no tiene nada que ver con el código.
await page.cdp("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

for (const item of CAPTURES) await capture(item.name, item.steps);

const text = `${blocks.join("\n\n")}\n`;
await fs.writeFile(OUT, text);
console.log(`\nOK -> ${OUT} (${text.length} bytes, ${CAPTURES.length} capturas)`);
