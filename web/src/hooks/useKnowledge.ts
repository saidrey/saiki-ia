import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";

export function useKnowledgeSearch(q: { query: string; category: string; status: string }) {
  return useQuery({
    queryKey: ["knowledge", q],
    queryFn: () => api.searchKnowledge(q),
    select: (r) => r.documents,
    placeholderData: keepPreviousData,
  });
}

export function useKnowledgeDoc(id: string) {
  return useQuery({
    queryKey: ["knowledge-doc", id],
    queryFn: () => api.getKnowledgeDoc(id),
    select: (r) => r.document,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 1,
  });
}
