import { Link } from "react-router";
import styles from "./Page.module.css";

export function NotFoundPage() {
  return (
    <section className={`${styles.page} ${styles.narrow}`} aria-labelledby="nf-title">
      <h1 id="nf-title" className={styles.title}>
        Esta página no existe
      </h1>
      <p className={styles.text}>
        Revisa la dirección o vuelve al <Link to="/">inicio</Link>.
      </p>
    </section>
  );
}
