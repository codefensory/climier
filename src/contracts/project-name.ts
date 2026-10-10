// Canonical display-name rules for a project. A project is identified by an
// opaque hash (its storage directory); this name is the only human-facing label
// and travels with the project metadata, never with the DAG.

export const PROJECT_NAME_MAX_LENGTH = 120;

/** Collapse whitespace and cap the length; null when there is nothing usable. */
export function normalizeProjectName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const collapsed = value.trim().replace(/\s+/gu, " ");
  if (!collapsed) {
    return null;
  }
  return [...collapsed].slice(0, PROJECT_NAME_MAX_LENGTH).join("");
}

/** Strict validation for user input: non-empty and not over the length cap. */
export function isValidProjectName(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const collapsed = value.trim().replace(/\s+/gu, " ");
  return collapsed.length > 0 && [...collapsed].length <= PROJECT_NAME_MAX_LENGTH;
}
