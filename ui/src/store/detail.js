// ui/src/store/detail.js
//
// Helpers for the detail extras slice. The detail endpoint returns
// relationships, history, refs, knowledge and payload-specific data
// that lives separately from the base entity in entities.nodes[id].
// The detail slice stores those extras keyed by node id so a poll that
// updates entities.nodes[id] does not replace the detail entry.
//
// Contract:
//   - getDetail(store, id) returns details[id] or undefined.
//   - hasDetail(store, id) returns true when details[id] is an object.
//   - applyDetail(setStore, id, payload) writes the payload into
//     details[id]. Missing id or non-object payloads are ignored.
//   - clearDetail(setStore, id) drops details[id].
//   - clearAllDetails(setStore) drops every cached detail.
//
// The slice is intentionally kept apart from entities.nodes[id];
// consumers must read the base node from entities and the extras
// from details[id].
//
// See .adrs/010-ui-live-store.md §2 / §3.5 and
// docs/plans/ui-live-store-execution.md §3.5 / §11.3.

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function getDetail(store, id) {
  if (!id || !store || typeof store !== "object") return undefined;
  const details = store.details;
  if (!details || typeof details !== "object") return undefined;
  return details[id];
}

export function hasDetail(store, id) {
  const entry = getDetail(store, id);
  return isPlainObject(entry);
}

export function applyDetail(setStore, id, payload) {
  if (!id || typeof id !== "string") return false;
  if (!isPlainObject(payload)) return false;
  setStore("details", id, payload);
  return true;
}

export function clearDetail(setStore, id) {
  if (!id || typeof id !== "string") return;
  setStore("details", id, undefined);
}

export function clearAllDetails(setStore) {
  setStore("details", {});
}
