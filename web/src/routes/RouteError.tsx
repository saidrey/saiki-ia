import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import styles from "./Page.module.css";

/** Error inesperado al cargar o renderizar una ruta. Dice qué pasó, sin inventar causas. */
export function RouteError() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `HTTP ${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Error desconocido.";

  return (
    <section className={`${styles.page} ${styles.narrow} ${styles.standalone}`} aria-labelledby="err-title">
      <h1 id="err-title" className={styles.title}>
        No se pudo mostrar esta página
      </h1>
      <p className={styles.text}>{detail}</p>
      <p className={styles.text}>
        Recarga la página o vuelve al <Link to="/">inicio</Link>.
      </p>
    </section>
  );
}
