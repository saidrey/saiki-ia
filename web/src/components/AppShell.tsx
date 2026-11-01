import { Outlet } from "react-router";
import { WorkspaceNav } from "./WorkspaceNav";
import styles from "./AppShell.module.css";

/** Navegación lateral plegable (común a todas las pantallas) + contenido. */
export function AppShell() {
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#contenido">
        Saltar al contenido
      </a>
      <WorkspaceNav />
      <main id="contenido" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
