import { useMutation, useMutationState } from "@tanstack/react-query";
import { api } from "../api/client";

const SEND_MESSAGE_KEY = ["send-message"] as const;

export interface SendMessageInput {
  sessionId: string;
  message: string;
}

/**
 * Envía un mensaje. La petición bloquea hasta que el moderador responde o el
 * grafo se pausa (minutos con agentes reales). La mutación vive en la caché
 * global, así que sigue registrada aunque se cambie de pantalla.
 */
export function useSendMessage() {
  return useMutation({
    mutationKey: SEND_MESSAGE_KEY,
    mutationFn: ({ sessionId, message }: SendMessageInput) => api.sendMessage(sessionId, message),
  });
}

export interface PendingMessage extends SendMessageInput {
  submittedAt: number;
}

/** Mensajes enviados desde esta pestaña cuya respuesta aún no llegó. */
export function usePendingMessages(): PendingMessage[] {
  return useMutationState({
    filters: { mutationKey: SEND_MESSAGE_KEY, status: "pending" },
    select: (m) => ({ ...(m.state.variables as SendMessageInput), submittedAt: m.state.submittedAt }),
  });
}
