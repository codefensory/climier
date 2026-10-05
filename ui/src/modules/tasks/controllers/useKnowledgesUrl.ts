import { useSearchParams } from "@solidjs/router";
import { createMemo } from "solid-js";
import type { KnowledgeGroupMode } from "../data/knowledges";

/** Knowledges registry presentation state is shareable URL state; only selection pushes history. */
export function useKnowledgesUrl() {
  const [params, setSearchParams] = useSearchParams();
  const one = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;
  const status = createMemo(() => one(params.status) ?? "all");
  const query = createMemo(() => one(params.query) ?? "");
  const group = createMemo<KnowledgeGroupMode>(() => one(params.group) === "scope" ? "scope" : "initiative");
  const selection = createMemo(() => one(params.knowledge) ?? "");

  const setStatus = (value: string) => setSearchParams({ status: value === "all" ? null : value }, { replace: true });
  const setQuery = (value: string) => setSearchParams({ query: value || null }, { replace: true });
  const setGroup = (value: KnowledgeGroupMode) => setSearchParams({ group: value === "initiative" ? null : value }, { replace: true });
  const setSelection = (value: string) => {
    if (selection() === value) return;
    setSearchParams({ knowledge: value || null }, { replace: false });
  };

  return { status, query, group, selection, setStatus, setQuery, setGroup, setSelection };
}
