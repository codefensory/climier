# Climier UI — Design Contract

This is the visual contract for `ui/`. The UI is a read-only projection of
Climier state. `ui/EXAMPLE.html` is the reference specimen for the detail
drawer: soft grey canvas, translucent white surfaces, compact Linear-like
controls, subtle semantic colour and a two-column detail workspace.

The dashboard should feel like a calm operations desk, not a marketing site.
Attention comes first, context follows, and history is progressively
disclosed.

## 1. Visual direction

- Light-only, quiet and dense without becoming cramped.
- Use the grey canvas to separate the workspace from white surfaces.
- Prefer hairline borders and small changes in surface colour over heavy
  shadows or saturated fills.
- The drawer is the strongest surface in the hierarchy: it floats above a
  blurred scrim and uses the reference specimen's inset, rounded treatment.
- Semantic colour is an accent, never the only carrier of meaning. Always
  pair it with a label, shape or position.
- The UI never mutates Climier state and never invents data.

## 2. Tokens

The implementation lives in `ui/src/index.css`. Values intentionally mirror
`ui/EXAMPLE.html` where the reference has a more specific value.

### 2.1 Surfaces and lines

| Token | Value | Use |
| --- | --- | --- |
| `canvas` | `#F6F7F9` | Application background |
| `panel` | `rgba(255,255,255,.94)` | Cards, tables, drawer surface |
| `panel-solid` | `#FFFFFF` | Opaque controls and selected tabs |
| `panel-muted` | `#FAFBFC` | Nested surfaces and side rails |
| `mid` | `#F2F4F7` | Selected controls, code blocks, separators |
| `line` | `#E7E9EE` | Hairline borders |
| `line-strong` | `#D9DDE5` | Hovered and focused borders |

The canvas may use the two very low-opacity radial gradients from the
reference. Gradients must stay quiet and must not compete with content.

### 2.2 Text

| Token | Value | Use |
| --- | --- | --- |
| `ink` | `#181A20` | Titles and primary content |
| `body` | `#3F4652` | Running copy and values |
| `mute` | `#717886` | Metadata, hints and timestamps |
| `mute-2` | `#9AA1AD` | Placeholder and tertiary metadata |

Use no extra arbitrary text colours in normal HTML. The graph may use its
semantic SVG palette for node labels and edges.

### 2.3 Semantic accents

| Token | Foreground | Soft surface | Meaning |
| --- | --- | --- | --- |
| `ready` | `#188A5B` | `#EBFBF3` | Ready, healthy, pass |
| `progress` | `#1769E0` | `#EDF5FF` | In progress, claimed, live |
| `blocked` | `#BE123C` | `#FFF1F3` | Blocked, error, fail |
| `gate` | `#A86509` | `#FFF7E8` | Gate, decision, pending |
| `knowledge` | `#7157D9` | `#F2EFFF` | Knowledge, durable context |
| `focus` | `#1769E0` | `#EDF5FF` | Keyboard focus and selection |

Semantic colours appear in badges, dots, small callouts and graph edges. A
status must still be understandable from its visible text and shape.

### 2.4 Typography

System fonts only. The mono stack is reserved for IDs, agent names, action
names, commands, timestamps and numeric counters.

| Role | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| Page | `25 / 30px` | 700 | View and drawer titles |
| Section | `15 / 21px` | 700 | Card and section headings |
| Body | `14 / 20px` | 400 | Normal copy and list content |
| Metadata | `12 / 16px` | 400 | IDs, timestamps and captions |
| Metric | `30 / 34px` | 700 | Operational counts |

Normal readable HTML must not render below 12px. The graph may use 9–11px
inside its internal SVG labels when required by the layout.

## 3. Geometry and layout

- Base spacing unit: 4px.
- Desktop page gutter: 20–32px; mobile gutter: 16–20px.
- Cards use 14px radius and 12–20px padding.
- Controls use 9px radius and are at least 36px tall; mobile controls are
  at least 44px when practical.
- Pills are reserved for statuses, kinds and tags. Buttons and cards are
  rounded rectangles, not pills.
- Tables use 48–56px rows. Lists use a minimum 36px hit area.
- Use `100dvh`, `min-h-0` and one intentional scroll owner per view.

### 3.1 Responsive shell

| Width | Shell |
| --- | --- |
| `>=1280px` | 240px labelled sidebar + topbar |
| `768–1279px` | 72px rail with glyphs + topbar |
| `<768px` | topbar with navigation drawer |

The project identity stays in the topbar. The active navigation item uses a
blue soft surface and a subtle inset accent; inactive items stay quiet.

### 3.2 Detail drawer

The node detail drawer follows `ui/EXAMPLE.html` as closely as the product
content allows:

- fixed to the right with 12px desktop inset;
- width `min(1120px, calc(100vw - 48px))`;
- 18px radius, white translucent surface, soft drawer shadow and backdrop
  saturation/blur;
- 54px topbar with breadcrumbs, kind/status, revision, copy, more and close;
- main content plus a 286px properties/activity rail;
- the main and rail scroll independently inside the drawer;
- at narrow widths the rail disappears and the drawer becomes an almost
  full-screen panel with 8px inset and 14px radius;
- Escape, backdrop click, Back, focus restoration and keyboard trapping remain
  functional.

The drawer hierarchy is: alert → title and status line → specification →
blockers → collapsible knowledge/notes/history/refs/relationships/CLI
sections. The right rail keeps properties and recent activity close at hand.

## 4. Shared components

Shared presentation primitives live in `ui/src/components.jsx`:

- `PageHeader` — eyebrow, title, subtitle, meta and actions.
- `Panel` — neutral surface with hairline border; no heavy shadow by default.
- `MetricCard` — operational count; becomes a button only with a real target.
- `StatusBadge` — semantic status pill with dot and visible text.
- `KindBadge` — compact squared task/gate/knowledge marker.
- `Chip` — compact initiative, scope or tag pill.
- `FilterBar` — white compact control strip with composable filters.
- `AlertBanner` — non-modal status/error surface.
- `EmptyState` — page, section and compact variants.
- `NodeRow` — keyboard-accessible node row.
- `ProgressBar` — task-state segments; never mixes kinds.
- `LiveStatus` — one read-only/last-refresh indicator in the shell.
- `Skeleton` — initial-load placeholder only.
- `IconButton` — labelled square control.
- `Time` / `ClaimTime` — relative time with absolute tooltip; claims prefer
  `claim.at` and fall back to `claim.ts`.

New reusable visual primitives belong in `components.jsx`, not in a single
view. View-specific layout classes may live in `index.css` when they describe
the drawer, shell or graph workspace rather than a data rule.

## 5. Interaction and accessibility

- Every interactive element is keyboard reachable and has an accessible name.
- Every interactive element has a visible `focus-visible` ring in `focus`.
- Minimum desktop target is 36px; use 44px on mobile touch controls.
- Hover changes surface/border, not only colour.
- Reduced-motion users receive no meaningful CSS animation or transition.
- Dialogs use `role="dialog"`, `aria-modal="true"`, a labelled name and
  focus management.
- Disclosure sections use native `<details>`/`<summary>` or equivalent
  keyboard-accessible controls.
- Truncated titles and previews expose the complete value through `title`.

## 6. Data states

The visual language preserves the snapshot contract:

1. Initial load shows skeletons, never a premature empty state.
2. Background refresh is non-blocking and leaves the last good snapshot in
   place.
3. Initial failure shows a retry surface.
4. Subsequent failure shows an alert while retaining the snapshot.
5. An uninitialized project explains `climier init`; the UI never runs it.
6. Empty collections use a compact, useful message. Filters offer a clear
   action when there are no matches.

## 7. Status and kind semantics

Status uses a dotted pill plus text (`ready`, `in_progress`, `blocked`,
`backlog`, `open`, `done`, etc.). Kind uses a compact squared marker so task,
gate and knowledge are distinguishable before reading the title. The graph
uses shape as a third channel: tasks are rectangles, gates diamonds and
knowledge circles.

No view may silently re-derive server-owned status semantics. The UI reads
pools and derived fields from the API snapshot.

## 8. Explicit non-goals

- No dark mode.
- No web fonts or icon dependency.
- No drag-and-drop or optimistic writes.
- No markdown/HTML rendering in user text.
- No charts without a time-series contract.
- No new runtime dependencies for the CLI.

## 9. Versioning

Update this file in the same change as token, component or drawer changes.
`ui/src/index.css` is the implementation companion; `ui/EXAMPLE.html` is the
visual reference specimen.
