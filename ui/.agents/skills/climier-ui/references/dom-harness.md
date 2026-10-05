# Arnés de DOM

Para qué: **demostrar que un refactor no cambió el render**. Las stories con `play` y axe verifican
comportamiento, no apariencia. Un refactor puede agregar un `<div>`, perder una clase de Tailwind o cambiar
un token de color sin que ninguna aserción se entere.

## Flujo

```bash
# 1. Con Storybook corriendo y el árbol quieto (ver SKILL.md)
.agents/skills/climier-ui/scripts/dev.sh start storybook

# 2. Antes
DOM_OUT=dom/before.txt ego-browser < .agents/skills/climier-ui/scripts/dom-capture.mjs

# 3. Cambiás el código

# 4. Después
DOM_OUT=dom/after.txt ego-browser < .agents/skills/climier-ui/scripts/dom-capture.mjs

# 5. Veredicto
node .agents/skills/climier-ui/scripts/normdom.mjs dom/before.txt dom/after.txt
```

Sale `IDÉNTICO …` (exit 0) o la lista de bloques con diferencias (exit 1), con los tokens **normalizados** de
los dos lados. Escribí las capturas en `dom/` en la raíz del repo —está en `.gitignore`— y **nunca en `/tmp`**:
`/tmp` se borra en cada reinicio y ya se perdió una vez el arnés entero.

Variables: `DOM_OUT` (salida), `SB_URL` (default `http://127.0.0.1:6006`), `DOM_STORY` (default `app--wide`),
`DOM_WIDTH`/`DOM_HEIGHT` (default 1440×900).

## Qué captura

15 estados de la app, cada uno desde una story recién cargada: Home, Tasks lista y kanban, los tres menús
abiertos, orden y agrupación aplicados, una condición de filtro, las vistas de relleno, y settings abierto y
cerrado.

Cada captura recarga la story. El estado de la app vive en la URL y **sobrevive entre capturas**: si se
encadenaran (abrir un menú, navegar, volver) cada una dependería de las anteriores y el orden pasaría a ser
parte del resultado. Recargando son independientes y no hay fugas.

Por captura se guardan tres cosas:

| Sección | Qué es | ¿Decide? |
|---|---|---|
| `-- metrics` | contadores (elementos, pintados, svgs), tamaño, URL | **no**, es informativo |
| `-- colors` | `getComputedStyle` de cada elemento pintado: color, fondos, bordes, outline, fill, stroke | **sí** |
| `-- dom` | el markup de la app | **sí** |

Los colores computados están porque un cambio de token no toca el markup: es la única forma de detectarlo sin
mirar píxeles.

`painted` queda fuera del veredicto porque depende de que las fuentes ya hayan cargado: puede oscilar entre
corridas y no debe decidir nada. El resto de las métricas se imprimen lado a lado para diagnosticar.

## Qué normaliza `normdom.mjs`

- **Orden de atributos.** El orden con que el navegador serializa no es un contrato: mover `class` antes de
  `data-testid` no cambió nada visible. Se ordenan alfabéticamente.
- **Nodos de texto sólo-espacios.** La indentación del JSX cambia esos nodos. Como se aplica a los dos lados,
  ignorarlos sólo afloja la comparación.

**No** normaliza el orden de los elementos ni los elementos mismos: mover un `<div>`, agregar un atributo o
perder una clase aparecen. Tampoco hay tolerancia: un byte distinto en el markup o en un color rompe el
`IDÉNTICO`. Es deliberado — con tolerancia, "¿es lo bastante parecido?" se vuelve una discusión en cada
refactor.

## Validá el arnés antes de creerle

**Un comparador roto dice `IDÉNTICO` para siempre, que es peor que no tenerlo: da confianza falsa.** Antes de
reportar un `IDÉNTICO`, meté una diferencia a propósito y comprobá que la ve:

```bash
cp dom/after.txt dom/injected.txt
# cambiá una clase y un color en dom/injected.txt con un editor cualquiera
node .agents/skills/climier-ui/scripts/normdom.mjs dom/after.txt dom/injected.txt
```

Y comprobá que dos corridas seguidas dan el **mismo sha256**: si no, el arnés mide el ruido (fuentes,
animaciones, tiempos) y no el código.

Esto no es teórico. La primera versión del filtro de raíces excluía `#storybook-root` —porque empieza con
`storybook-`, el mismo prefijo que el chrome de Storybook— así que capturaba **cuatro divs portaleados** y
reportaba `IDÉNTICO` en todas las corridas. Se descubrió inyectando una diferencia, y por eso ahora hay una
guardia que falla si `#storybook-root` no existe o está vacío.

La superposición de error de Storybook (`.sb-errordisplay`) existe siempre en el DOM, oculta y 0×0. Está
excluida por estructura, y además hay un chequeo explícito de que esté en `display: none`: si una story tira
un error, la captura falla en vez de guardar un archivo que parecería correcto.

## Límites

- **Sirve para: ¿cambió algo?** No sirve para **¿está bien?** Compara contra sí mismo. Un bug que ya estaba
  en la línea base es invisible para el arnés (el `landmark-unique` de `SettingsPage` lo encontró axe, no
  esto).
- Las capturas **no** se commitean: son un artefacto local. El flujo es antes/después en la misma sesión de
  trabajo. `dom/after.txt` de un refactor terminado es la línea base natural del siguiente.
- Si una captura falla en un paso de interacción (`no existe la opción "X" (hay: …)`), la lista de capturas
  quedó vieja porque alguien renombró algo en la UI. Actualizá el paso: el arnés compara estados, así que un
  estado que ya no se puede alcanzar tiene que doler.
- Diferencia en `-- metrics` con `-- dom` y `-- colors` idénticos: casi siempre es timing (fuentes, 400 ms de
  asentamiento). No es un cambio de render.
