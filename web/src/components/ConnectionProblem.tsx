import styles from "./ConnectionProblem.module.css";

/** Qué hacer cuando la API no responde. */
export function ConnectionProblem() {
  return (
    <section className={styles.box} aria-labelledby="conn-title">
      <h2 id="conn-title" className={styles.title}>
        La API de Saiki-IA no responde
      </h2>
      <p className={styles.text}>Arranca el backend desde la raíz del repositorio; esta página se actualizará sola.</p>
      <pre className={styles.command}>
        <code>nvm use 22{"\n"}npm run serve</code>
      </pre>
    </section>
  );
}
