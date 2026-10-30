# Skills de UI/UX y frontend — registro de procedencia

Skills de Claude Code instaladas **a nivel de proyecto** para la futura interfaz
(Jev, Fase 21). Copiadas sin modificar desde los repositorios originales
(clon `--depth 1`, inspeccionadas antes de copiar). No se ejecutó ningún
instalador (`npx skills`, `claude plugin install`, etc.) ni se instalaron
dependencias. Reglas de uso coordinado: ver `CLAUDE.md` en la raíz.

Instalado: 2026-10-29.

| Skill (carpeta) | Fuente | Ruta en origen | Commit | Versión | Licencia |
|---|---|---|---|---|---|
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) | `skills/frontend-design` | `ca45fc496a3436251f191354091d557da31c15b5` | sin versión | Apache-2.0 (`LICENSE.txt`) |
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `.claude/skills/ui-ux-pro-max` | `28b3b8dee8c976df4fa3e94aed4e092ad43fcb03` | 2.15.0 | MIT (`LICENSE` copiado de la raíz del repo) |
| `vercel-react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | `skills/react-best-practices` | `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` | 1.0.0 (SKILL.md / metadata.json) | MIT declarado en SKILL.md; el repo no incluye archivo LICENSE |
| `accessibility-scan`, `accessibility-inspect`, `accessibility-audit`, `accessibility-fix`, `accessibility-diff`, `shared/` | [AccessLint/claude-marketplace](https://github.com/AccessLint/claude-marketplace) (antes `AccessLint/skills`, redirige) | `plugins/accesslint/skills/*` | `2e9d7336678302d0bc08848e92542560295b34d3` | 0.10.3 (plugin.json) | MIT declarado en `plugin.json`; el repo no incluye archivo LICENSE |

`shared/` no es una skill: contiene `methodology.md`, referenciado por las skills
de AccessLint como `../shared/methodology.md`.

## Huellas de integridad

Hash SHA-256 (primeros 16 caracteres) del listado ordenado de `sha256` de cada
archivo de la carpeta, excluyendo `LICENSE`:

```
frontend-design        180ab393af52fde7
ui-ux-pro-max          292d31b5b61921f0
accessibility-audit    b34c39d4aa519899
accessibility-diff     4eaeff0dfbac31fa
accessibility-fix      b418d66f567111bd
accessibility-inspect  d8e2166ae2279d76
accessibility-scan     0bb1f63530566a74
shared                 a1cc99ebea83eca0
vercel-react-best-practices  99c51ec5786b76eb
```

Recalcular (desde la raíz del repo):

```bash
for d in frontend-design ui-ux-pro-max accessibility-audit accessibility-diff \
         accessibility-fix accessibility-inspect accessibility-scan shared \
         vercel-react-best-practices; do
  h=$(cd ".claude/skills/$d" && find . -type f ! -name LICENSE | LC_ALL=C sort \
      | xargs shasum -a 256 | shasum -a 256 | cut -c1-16)
  echo "$d $h"
done
```

## Notas de seguridad de la revisión

- **frontend-design**: solo Markdown. Sin scripts.
- **ui-ux-pro-max**: Markdown + CSV/JSON + scripts Python (solo librería
  estándar, sin red ni `subprocess`). `search.py` solo lee datos locales; con
  `--persist` escribe `design-system/<proyecto>/MASTER.md` en `--output-dir`.
- **vercel-react-best-practices** (instalada 2026-10-30, al elegirse React para
  `web/`): solo Markdown + `metadata.json` (72 reglas). Sin scripts. Muchas reglas
  son de Next.js/servidor (`server-*`, RSC); en `web/` (SPA con Vite) aplican las
  de cliente: `bundle-*`, `client-*`, `rerender-*`, `rendering-*`, `js-*`.
- **AccessLint**: solo Markdown, pero las skills **ejecutan en tiempo de uso**
  `npx -y @accesslint/cli@latest` y `npx -y @accesslint/chrome@latest`
  (descargan paquetes npm sin versión fija y lanzan Chrome con depuración).
  No se instaló el servidor MCP del plugin (`@accesslint/mcp@latest`); las
  herramientas `mcp__plugin_accesslint_accesslint__*` que algunas skills
  mencionan no existen en esta instalación, y las skills funcionan con la CLI.
  Las referencias `accesslint:<skill>` del texto corresponden a la skill local
  `<skill>` (sin prefijo, porque no se instalaron como plugin).

## Pendientes / evaluadas

| Skill | Estado | Motivo |
|---|---|---|
| `impeccable` ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), v4.8.0, Apache-2.0) | Evaluada, no instalada | Útil para refinamiento visual (`polish`, `critique`, `audit`), pero se solapa con `frontend-design` y trae 12 scripts JS (inyección en navegador en vivo) que requieren revisión aparte. Reconsiderar cuando exista UI que pulir. |

## Actualizar una skill

Clonar el repo original, revisar el diff contra la carpeta local, reemplazar la
carpeta completa y actualizar commit, versión y huella en esta tabla.
