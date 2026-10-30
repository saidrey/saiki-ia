import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

/** Intervalo de comprobación de `/health` mientras la app está abierta. */
const HEALTH_INTERVAL_MS = 15_000;

export type ApiConnection = "checking" | "connected" | "unreachable";

/** Estado de la conexión con la API, derivado solo de `GET /health`. */
export function useHealth(): { connection: ApiConnection; checkedAt: number | null } {
  const q = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: HEALTH_INTERVAL_MS,
    retry: false,
  });
  const connection: ApiConnection = q.isPending ? "checking" : q.isSuccess && q.data.ok ? "connected" : "unreachable";
  const checkedAt = q.dataUpdatedAt || q.errorUpdatedAt || null;
  return { connection, checkedAt };
}
