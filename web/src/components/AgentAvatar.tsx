import type { ResponsibleKind } from "../model/agents";
import styles from "./AgentAvatar.module.css";

/**
 * Identidad compacta del responsable de una etapa: forma y monograma propios
 * (no logotipos). Decorativo: el nombre va siempre en texto al lado o en el
 * inspector.
 */
export function AgentAvatar({ kind, size = 20, active = false }: { kind: ResponsibleKind; size?: number; active?: boolean }) {
  return (
    <svg className={styles.avatar} data-kind={kind} data-active={active ? "" : undefined} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      {kind === "kiro" ? (
        <>
          <rect className={styles.plate} x="1" y="1" width="18" height="18" rx="5" />
          <path className={styles.ink} d="M7.2 5.5v9M12.8 5.5L7.6 10.3l5.4 4.2" />
        </>
      ) : kind === "claude" ? (
        <>
          <circle className={styles.plate} cx="10" cy="10" r="9" />
          <path className={styles.ink} d="M13.3 7a4 4 0 1 0 0 6" />
        </>
      ) : kind === "human" ? (
        <>
          <path className={styles.plate} d="M10 1l9 9-9 9-9-9z" />
          <circle className={styles.ink} cx="10" cy="8.4" r="1.9" />
          <path className={styles.ink} d="M6.8 13.2c.8-2.2 5.6-2.2 6.4 0" />
        </>
      ) : kind === "applier" ? (
        <>
          <path className={styles.plate} d="M10 1.5l7 2.6v5.2c0 4.4-3 7.4-7 9.2-4-1.8-7-4.8-7-9.2V4.1z" />
          <path className={styles.ink} d="M7 10l2.2 2.2L13.4 8" />
        </>
      ) : (
        <>
          <rect className={styles.plate} x="1" y="1" width="18" height="18" rx="9" />
          <path className={styles.ink} d="M5.5 10h2M12.5 10h2" />
          <circle className={styles.ink} cx="10" cy="10" r="1.6" />
        </>
      )}
    </svg>
  );
}
