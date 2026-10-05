import { useSearchParams } from "@solidjs/router";
import { createMemo } from "solid-js";
import type { GateGroupMode } from "../data/gates";

/** Gate registry presentation state lives in search params and uses replace for filter edits. */
export function useGatesUrl() {
  const [params, setSearchParams] = useSearchParams();
  const one = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;
  const status = createMemo(() => one(params.status) ?? "all");
  const query = createMemo(() => one(params.query) ?? "");
  const group = createMemo<GateGroupMode>(() => {
    const value = one(params.group);
    return value === "purpose" || value === "chain" ? value : "initiative";
  });
  const selection = createMemo(() => one(params.gate) ?? "");

  const setStatus = (value: string) => setSearchParams({ status: value === "all" ? null : value }, { replace: true });
  const setQuery = (value: string) => setSearchParams({ query: value || null }, { replace: true });
  const setGroup = (value: GateGroupMode) => setSearchParams({ group: value === "initiative" ? null : value }, { replace: true });
  const setSelection = (value: string) => {
    if (selection() === value) return;
    setSearchParams({ gate: value || null }, { replace: false });
  };

  return { status, query, group, selection, setStatus, setQuery, setGroup, setSelection };
}
