// Browser-only palette reader for the Cytoscape Graph (ADR-003 §Paleta).
//
// Cytoscape paints on <canvas> and cannot consume CSS variables directly,
// so this module is the single bridge between the design tokens defined
// in ui/src/index.css and the concrete strings the stylesheet needs.
//
// Contract:
//   - Importing this module must NOT touch the DOM. The readGraphPalette
//     helper is the only entry point that reads computed values, and it
//     is invoked from the browser when Graph.jsx mounts.
//   - The module does not duplicate hex literals. Every token names a CSS
//     variable (the `--ui-*` series and `--color-blocked` for the blocked
//     series, which lives in Tailwind's @theme block). All hex values
//     stay in ui/src/index.css — change there, recompute here.
//
// The shape mirrors the static tables previously inlined in Graph.jsx
// (EDGE_COLORS, STATUS_COLORS, STATUS_DEFAULT) so a future stylesheet
// factory task can spread the resolved palette into cytoscape rules
// without further mapping work.

export const TOKENS = Object.freeze({
  // Surfaces used by node, gate and knowledge shapes.
  nodeFill: "--ui-panel-muted",
  gateFill: "--ui-amber-soft",
  knowledgeFill: "--ui-violet-soft",

  // Default border and label colors when no status / kind class applies.
  nodeBorderDefault: "--ui-line-strong",
  nodeLabel: "--ui-body",
  nodeLabelMuted: "--ui-muted",
  nodeLabelStrong: "--ui-text",

  // Status table: stroke drives `border-color` on the cytoscape node and
  // text drives the canvas label when a future stylesheet factory exposes
  // it. The pair shape mirrors Graph.jsx's STATUS_COLORS so no
  // information is lost when the stylesheet migrates.
  status: Object.freeze({
    open:        Object.freeze({ stroke: "--ui-amber",       text: "--ui-amber"       }),
    in_progress: Object.freeze({ stroke: "--ui-blue",        text: "--ui-blue"        }),
    done:        Object.freeze({ stroke: "--ui-green",       text: "--ui-green"       }),
    canceled:    Object.freeze({ stroke: "--ui-line-strong", text: "--ui-muted"       }),
    blocked:     Object.freeze({ stroke: "--color-blocked",  text: "--color-blocked"  }),
    resolved:    Object.freeze({ stroke: "--ui-violet",      text: "--ui-violet"      }),
    superseded:  Object.freeze({ stroke: "--ui-violet",      text: "--ui-violet"      }),
    deprecated:  Object.freeze({ stroke: "--ui-line-strong", text: "--ui-muted"       }),
    active:      Object.freeze({ stroke: "--ui-violet",      text: "--ui-violet"      }),
    stale:       Object.freeze({ stroke: "--ui-amber",       text: "--ui-amber"       }),
  }),

  // Edge color table. BLOCKS uses the blocked series from Tailwind's
  // @theme block because the UI does not yet expose a `--ui-blocked`
  // alias; SUPERSEDES / DERIVED_FROM reuse the violet/blue UI tokens;
  // INFORMS, RELATES_TO and CONFLICTS_WITH share the muted-2 grey so
  // unknown / neutral edges stay quiet against the canvas.
  edge: Object.freeze({
    BLOCKS:         "--color-blocked",
    SUPERSEDES:     "--ui-violet",
    DERIVED_FROM:   "--ui-blue",
    INFORMS:        "--ui-muted-2",
    RELATES_TO:     "--ui-muted-2",
    CONFLICTS_WITH: "--ui-muted-2",
  }),

  // Focus + selection color. Drives node.selected.border-color and the
  // overlay button ring so keyboard focus matches the cytoscape highlight.
  focus: "--ui-blue",
});

export const STATUS_KEYS = Object.freeze(Object.keys(TOKENS.status));
export const EDGE_KEYS = Object.freeze(Object.keys(TOKENS.edge));

function readVar(root, name) {
  // getComputedStyle returns the variable value with a leading space when
  // the property is set as `--foo: #1769e0;`. Trim so the cytoscape
  // stylesheet receives the exact color string.
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  if (!value) {
    throw new Error(`graph-palette: CSS variable ${name} is not defined on the document root`);
  }
  return value;
}

// readGraphPalette(root) returns the resolved palette as a flat object
// ready to feed cytoscape's stylesheet. Browser-only: getComputedStyle
// requires a live document, so the helper must not be invoked from SSR,
// prerender or Node contexts.
export function readGraphPalette(root = (typeof document !== "undefined" ? document.documentElement : null)) {
  if (!root) {
    throw new Error("graph-palette: readGraphPalette requires a DOM root; not available in this environment");
  }
  const status = {};
  for (const key of STATUS_KEYS) {
    status[key] = {
      stroke: readVar(root, TOKENS.status[key].stroke),
      text: readVar(root, TOKENS.status[key].text),
    };
  }
  const edge = {};
  for (const key of EDGE_KEYS) {
    edge[key] = readVar(root, TOKENS.edge[key]);
  }
  return Object.freeze({
    nodeFill: readVar(root, TOKENS.nodeFill),
    gateFill: readVar(root, TOKENS.gateFill),
    knowledgeFill: readVar(root, TOKENS.knowledgeFill),
    nodeBorderDefault: readVar(root, TOKENS.nodeBorderDefault),
    nodeLabel: readVar(root, TOKENS.nodeLabel),
    nodeLabelMuted: readVar(root, TOKENS.nodeLabelMuted),
    nodeLabelStrong: readVar(root, TOKENS.nodeLabelStrong),
    status: Object.freeze(status),
    edge: Object.freeze(edge),
    focus: readVar(root, TOKENS.focus),
  });
}

// Default export mirrors the named exports so consumers can pick either
// shape. The contract is the same: import is DOM-free, only readGraphPalette
// touches the browser.
export default { TOKENS, STATUS_KEYS, EDGE_KEYS, readGraphPalette };