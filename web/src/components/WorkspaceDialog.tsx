import { useEffect, useRef, type ReactNode } from "react";
import styles from "./WorkspaceDialog.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  /** id del encabezado que nombra el contenido. */
  labelledBy: string;
  children: ReactNode;
}

/**
 * Modal del workspace para la información secundaria (detalle de etapa,
 * resultado, actividad…). `<dialog>` nativo: foco atrapado, Escape y
 * restauración del foco al cerrar los da el navegador.
 */
export function WorkspaceDialog({ open, onClose, labelledBy, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Clic en el fondo (fuera del contenido): cerrar.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button type="button" className={styles.close} onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
        <span className="visually-hidden">Cerrar</span>
      </button>
      <div className={styles.body}>{open ? children : null}</div>
    </dialog>
  );
}
