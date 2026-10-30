import type { ApiConnection } from "../hooks/useHealth";
import styles from "./ApiStatus.module.css";

const LABEL: Record<ApiConnection, string> = {
  checking: "Comprobando API",
  connected: "API conectada",
  unreachable: "API sin conexión",
};

/** Indicador de conexión: forma + texto, nunca solo color. */
export function ApiStatus({ connection }: { connection: ApiConnection }) {
  return (
    <span className={styles.status} data-state={connection} role="status">
      <svg className={styles.mark} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        {connection === "connected" ? (
          <circle cx="6" cy="6" r="5" />
        ) : connection === "unreachable" ? (
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
        ) : (
          <circle cx="6" cy="6" r="4.25" />
        )}
      </svg>
      {LABEL[connection]}
    </span>
  );
}
