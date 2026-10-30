# Prueba de integración manual — Claude Code real (Fase 5)

Valida el rol `develop` contra **Claude Code real en modo PROPUESTA**: genera
código como texto, **sin escribir ni ejecutar nada** en el repositorio. No forma
parte de `npm test` (que es determinista y no llama a Claude).

## Mecanismo de permisos (verificado contra `claude --help`, v2.1.251)

El rol `develop` invoca Claude con estos flags, verificados empíricamente:

| Flag | Efecto |
| --- | --- |
| `-p` | Modo no interactivo (print y salir). |
| `--tools ""` | Desactiva TODAS las herramientas built-in (Bash/Write/Edit/Read/REPL). |
| `--restricted` | Quita herramientas que ejecutan comandos o código. |
| `--strict-mcp-config` | Ignora servidores MCP (podrían escribir). |
| `--disallowedTools Write Edit Bash` | Denegación explícita (defensa en profundidad). |

El prompt se pasa por **stdin**, NO como argumento posicional.

> Gotcha verificado: `--disallowedTools <tools...>` es variádico. Si el prompt
> va como argumento posicional después de ese flag, Claude interpreta cada
> palabra del prompt como un nombre de tool a denegar
> ("Permission deny rule ... matches no known tool"). Por eso el prompt va por
> stdin.

## Evidencia de seguridad (criterio de aprobación del PO)

Prueba empírica directa contra la CLI (en un directorio temporal): se le pidió
explícitamente crear y modificar archivos. Resultado: **el repositorio quedó
intacto** (sin archivos nuevos, sin cambios de contenido, MD5 idéntico), incluso
cuando el modelo "dijo" que iba a hacerlo. Lo que impide la modificación es el
mecanismo de permisos, no el prompt.

## Requisitos previos

```bash
claude --version        # 2.1.251 (Claude Code) — autenticado
kiro-cli --version      # con sesión SSO activa (kiro-cli login)
nvm use 22
```

## Cómo ejecutar

```bash
nvm use 22
npm run manual:claude
```

## Qué esperar

El script ejecuta el grafo real (Kiro analiza → Claude desarrolla → review
simulado) y verifica la integridad del repo con una huella (ruta+tamaño+mtime)
de `src/` antes y después.

- `status: approved`.
- `developApplied: false` (la propuesta NO es un cambio aplicado).
- La propuesta de Claude aparece marcada con `[PROPUESTA]`.
- **"OK: el repositorio permanece INTACTO (0 archivos modificados)."**

Si algún archivo cambiara, el script imprime el detalle y sale con código 1
(fallo de seguridad).

## Limitaciones

- Solo `develop` (Claude) y `analyze` (Kiro) son reales; `review` sigue simulado.
- **NO se aplican cambios al repositorio**. La escritura real y las aprobaciones
  humanas (human-in-the-loop) son una fase posterior, aún no implementada.
- Cada corrida consume cuota de Claude y créditos de Kiro; por eso es opt-in.
