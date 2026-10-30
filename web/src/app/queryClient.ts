import { MutationCache, QueryClient } from "@tanstack/react-query";

/**
 * Un único QueryClient por carga de la app (advanced-init-once). La API es la
 * fuente de verdad: sin datos iniciales ni placeholders inventados.
 *
 * Al terminar cualquier acción (mensaje, decisión), se invalida todo: el estado
 * que importa lo recalcula el backend y hay pocas consultas activas.
 */
export const queryClient: QueryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSettled: () => queryClient.invalidateQueries(),
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

/** Intervalo de consulta mientras el backend trabaja (sondeo verificado en real). */
export const ACTIVE_POLL_MS = 2_500;
