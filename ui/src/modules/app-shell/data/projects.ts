import type { Project } from "../types";

/**
 * Proyectos del workspace.
 *
 * Cada proyecto usa un tono de `tokens.css`. El chip de un label con el mismo tono comparte
 * los mismos valores: verde = Design/Atlas, ámbar = Billing/Nimbus, azul = Platform/Orion,
 * malva = Accessibility/Helio.
 */
export const projects: Project[] = [
  { label: "All projects", background: "var(--color-chip)", textColor: "var(--color-muted)", initial: "", all: true },
  { label: "Atlas CRM Revamp", background: "var(--color-tone-green-bg)", textColor: "var(--color-tone-green-ink)", initial: "A" },
  { label: "Nimbus Dashboard", background: "var(--color-tone-amber-bg)", textColor: "var(--color-tone-amber-ink)", initial: "N" },
  { label: "Orion API Gateway", background: "var(--color-tone-blue-bg)", textColor: "var(--color-tone-blue-ink)", initial: "O" },
  { label: "Helio Task System", background: "var(--color-tone-mauve-bg)", textColor: "var(--color-tone-mauve-ink)", initial: "H" },
];
