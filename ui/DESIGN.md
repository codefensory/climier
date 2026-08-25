# Climier UI — Design Contract

Read-only dashboard for the Climier CLI. The CLI is the source of truth; the
UI projects its state. No mutations, no shadow databases, no optimistic
writes. Everything below describes the visual contract that the dashboard
implements.

This document supersedes the prior `DESIGN.md` (which described an unrelated
marketing site). It is the single source of truth for visual rules in `ui/`.
It evolves together with `docs/ui-redesign-plan.md`.

## 1. Concept

**An operations desk** — calm, clear, prioritised. The dashboard answers
three questions first:

1. What needs attention right now?
2. What is the project doing, and who is doing it?
3. What is the historical record?

Everything else (board, graph, detail, audit) lives behind progressive
disclosure. Attention surfaces first; context follows; history is opt-in.

## 2. Tokens

Defined in `ui/src/index.css` via Tailwind v4 `@theme`. The values below are
the contract; the CSS file is the implementation.

### 2.1 Surface (light only)

| Token         | Value     | Role                                                    |
| ------------- | --------- | ------------------------------------------------------- |
| `canvas`      | `#F6F7F9` | App background                                          |
| `panel`       | `#FFFFFF` | Cards, tables, surfaces on top of canvas                |
| `panel-2`     | `#F1F3F5` | Nested surfaces, hovered rows, sub-panels               |
| `mid`         | `#E5E7EB` | Selected controls, strong dividers                       |
| `line`        | `#D9DEE5` | Hairline borders (1 px solid)                           |

### 2.2 Text

| Token   | Value     | Role                                                   |
| ------- | --------- | ------------------------------------------------------ |
| `ink`   | `#111318` | Titles and primary content                             |
| `body`  | `#3F4652` | Running copy                                           |
| `mute`  | `#6B7280` | Metadata, timestamps, captions                         |

Body text uses `ink`/`body`/`mute` in that order. No fourth text colour.

### 2.3 Semantic

| Token        | Foreground | Soft background | Meaning                       |
| ------------ | ---------- | --------------- | ----------------------------- |
| `ready`      | `#047857`  | `#ECFDF5`       | Ready / healthy / pass        |
| `progress`   | `#0369A1`  | `#F0F9FF`       | In progress / claim / live    |
| `blocked`    | `#BE123C`  | `#FFF1F3`       | Blocked / error / fail        |
| `gate`       | `#A16207`  | `#FEFCE8`       | Gate / decision / pending     |
| `knowledge`  | `#6D28D9`  | `#F5F3FF`       | Knowledge / fact              |
| `focus`      | `#2563EB`  | `#EFF6FF`       | Focus ring and selection      |

Soft variants are tinted backgrounds for chips, badges, and rows. Foreground
on a soft background must meet WCAG AA (≥4.5:1) against `ink`; the soft
backgrounds above were chosen so that the foreground colour itself remains
the readable layer on white. Pair semantics with **shape and text**, never
colour alone — see §6.

### 2.4 Typography

System font stack. No web fonts. The mono stack is reserved for IDs,
command names, timestamps, and counters.

| Role     | Size | Line height | Weight | Used by                          |
| -------- | ---- | ----------- | ------ | -------------------------------- |
| Page     | 24px | 32px        | 600    | Page titles (Overview, Tasks)    |
| Section  | 16px | 24px        | 600    | Section titles, card headers     |
| Body     | 14px | 20px        | 400    | Running copy, list items         |
| Metadata | 12px | 16px        | 400    | IDs, timestamps, captions        |
| Metric   | 30px | 36px        | 600    | Operational numbers on Overview  |

**Nothing renders below 12 px.** Internal graph nodes may compress to 11 px
if the layout demands it, but never for text the user is expected to read.

Mono is opt-in via `.mono`. Use it for: node IDs, agent IDs, command names,
timestamps (relative and absolute), byte/count metrics. Do not use it for
titles, body copy, or any sentence the user reads.

### 2.5 Radii and shapes

| Token         | Value | Role                                          |
| ------------- | ----- | --------------------------------------------- |
| `card`        | 12px  | Cards, panels, drawer surfaces                |
| `control`     | 8px   | Buttons, inputs, selects, tabs                |
| `pill`        | 9999  | Reserved for badges and status chips only     |

Cards are rectangles with rounded corners; controls are softer rectangles.
Pills are not a generic shape — they exist for badges, status chips, and
counters. Buttons are not pills.

### 2.6 Elevation

| Level | Treatment                                  | Used by                       |
| ----- | ------------------------------------------ | ----------------------------- |
| 0     | No shadow, no border                       | Canvas                        |
| 1     | 1 px solid `line`                          | Cards, panels, tables         |
| 2     | Hairline + 2 px solid `mid`                | Selected rows, focused card   |
| 3     | Hairline + soft shadow (drawer / popover)  | Drawers, popovers, dialogs    |

No drop shadows on cards. Drawers and popovers separate from the canvas
through a soft shadow; everything else stays flat with a hairline.

## 3. Spacing and layout

- Base unit: **4 px**.
- Card padding: 16 px (compact) or 20 px (standard).
- Table row height: 48 px (compact) or 56 px (standard).
- Section separation: 24 px.
- Page gutter: 32 px desktop, 16 px mobile.
- Controls: minimum **36 px** desktop, **44 px** mobile touch target.

### 3.1 Breakpoints

| Name   | Width       | Sidebar        | Board                       |
| ------ | ----------- | -------------- | --------------------------- |
| Wide   | ≥ 1280 px   | 240 px         | Full bleed                  |
| Mid    | 768–1279 px | 64 px rail     | min 280 px columns + hscroll |
| Narrow | < 768 px    | Topbar + drawer | Cards in single column     |

Use `100dvh`, `min-h-0`, and one scroll owner per view. No nested scrollers.

## 4. Components

Defined in `ui/src/components.jsx`. The list is the contract; new shared
primitives are added to `components.jsx`, not to view files.

- `PageHeader` — title, subtitle, contextual meta, and actions.
- `Panel` — surface with hairline border and `card` radius.
- `MetricCard` — number, label, one-line explanation. Becomes a `<button>`
  when it navigates; `<div>` otherwise.
- `StatusBadge` — pill with semantic foreground + soft background.
- `KindBadge` — pill distinguishing task / gate / knowledge.
- `Chip` — small pill for initiative, scope, tag.
- `FilterBar` — search + filters + clear-all. Empty result includes
  "Clear filters".
- `AlertBanner` — non-modal banner at the top of the page; preserves the
  underlying view.
- `EmptyState` — variants: page (with CTA), section (compact), compact
  (single line for "all healthy").
- `NodeRow` — row in the Tasks / Gates / Knowledge tables.
- `ProgressBar` — segmented bar for initiative breakdown by state.
- `LiveStatus` — the single floating last-refresh timestamp + read-only badge.
- `Skeleton` — initial load placeholder. Never mixes with content.
- `IconButton` — square icon-only control; requires `aria-label`.
- `Time` — relative time with absolute timestamp in `title`.

## 5. Data states

The dashboard projects a live snapshot. Every view handles four states
without leaking between them:

1. **Initial load** — skeleton. No partial data, no empty state.
2. **Refresh in progress** — non-blocking indicator. Last snapshot stays
   on screen.
3. **Initial error** — error screen with retry. No cached data fallback.
4. **Subsequent error** — last snapshot stays on screen + `AlertBanner`
   with the error. The view never blanks.

If the project is not initialised (no state file), the dashboard renders a
single empty state pointing to the CLI command (`climier init`). The UI
never runs the mutation itself.

## 6. Status semantics

State is conveyed by **colour + shape + text**, never colour alone.

- Pill (status badge): ready / progress / blocked / gate / knowledge.
- Square (kind badge): task / gate / knowledge.
- Border + text colour together: selected row, current item.
- Iconography in the future may add a fourth channel; never a substitute
  for the first three.

A colourblind user must still be able to distinguish `blocked` from `gate`
without parsing hue. The pill shape plus the label text is the redundancy.

## 7. Interaction

- Every interactive element is reachable by keyboard.
- Every interactive element has a visible `focus-visible` ring (`focus`,
  2 px, 2 px offset, `control` radius).
- Every interactive element has an accessible name (`aria-label` if
  icon-only; visible label otherwise).
- Touch targets ≥ 36 px desktop, ≥ 44 px mobile.
- Reduced-motion users get no animations at the CSS layer; state-driven
  transitions should also consult `prefers-reduced-motion`.
- Selection colour is `focus` on `focus-soft`.

## 8. What this UI does not do

- No dark mode (light canvas only, by design).
- No web fonts (system stack only).
- No icon library (iconography deferred).
- No drag-and-drop (board is read-only).
- No charts or trend lines (no time-series in the snapshot).
- No markdown rendering in the UI (text is text; commands are copy buttons).
- No writes (every endpoint is GET; the UI never mutates state).

## 9. Versioning

This document ships in lock-step with the visual changes it describes.
Changes to tokens, components, or states require updating this file in
the same commit. The companion implementation is `ui/src/index.css`;
companion plan is `docs/ui-redesign-plan.md`.
