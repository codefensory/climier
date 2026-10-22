import type { ReadModelLogEntry, ReadModelSnapshot } from "./types.ts";

export function logEntriesForNode(snapshot: ReadModelSnapshot | null | undefined, id: string): ReadModelLogEntry[] {
  return (snapshot?.log || []).filter((entry) => entry?.node === id
    || (typeof entry?.note === "string" && entry.note.split(/\s+/).includes(id)));
}
