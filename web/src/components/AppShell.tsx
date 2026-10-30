import { Link, NavLink, Outlet, useLocation } from "react-router";
import { useHealth } from "../hooks/useHealth";
import { ApiStatus } from "./ApiStatus";
import styles from "./AppShell.module.css";

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? `${styles.navLink} ${styles.navActive}` : styles.navLink);

/** Cabecera fija + contenido. La navegación crece con cada página implementada. */
export function AppShell() {
  const { connection } = useHealth();
  const { pathname } = useLocation();
  // Sesión y ejecución pertenecen a la sección "Sesiones".
  const inSessions = pathname === "/" || pathname.startsWith("/sessions/") || pathname.startsWith("/executions/");
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#contenido">
        Saltar al contenido
      </a>
      <header className={styles.header}>
        <div className={styles.left}>
          <Link to="/" className={styles.brand}>
            Saiki-IA
          </Link>
          <nav aria-label="Principal" className={styles.nav}>
            <NavLink to="/" className={() => navClass({ isActive: inSessions })} aria-current={inSessions ? "page" : undefined}>
              Sesiones
            </NavLink>
            <NavLink to="/projects" className={navClass}>
              Proyectos
            </NavLink>
            <NavLink to="/knowledge" className={navClass}>
              Conocimiento
            </NavLink>
          </nav>
        </div>
        <ApiStatus connection={connection} />
      </header>
      <main id="contenido" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
