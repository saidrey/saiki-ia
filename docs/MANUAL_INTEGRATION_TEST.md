# Prueba de integración manual — Kiro CLI real (Fase 4)

Esta prueba valida que el rol `analyze` funciona contra **Kiro CLI real**. No
forma parte de `npm test` (que es determinista y nunca llama a Kiro), porque una
llamada real es lenta, consume créditos del plan y su salida no es determinista.

## Requisitos previos

1. **Kiro CLI instalado**:
   ```bash
   kiro-cli --version      # p. ej. 2.35.2
   ```
   Instalación (si falta): `brew install --cask kiro-cli`.

2. **Sesión SSO activa** (reutilizamos la autenticación del entorno; el código
   NO inicia sesión ni guarda credenciales):
   ```bash
   kiro-cli login
   ```
   Abre el navegador, autentícate con tu SSO. La sesión queda guardada localmente.

3. **Node 22** (el proyecto usa Node 22 vía nvm; no toca tu Node global):
   ```bash
   nvm use 22
   ```

## Cómo ejecutar

```bash
nvm use 22
npm run manual:kiro
```

## Qué esperar

**Caso éxito (sesión SSO activa):**
- El `plan` lo genera Kiro CLI real (el texto varía en cada corrida).
- `develop` y `review` siguen simulados.
- Salida final: `status: approved`.

**Caso fallo (sin sesión, o Kiro CLI no disponible):**
- El flujo NO ejecuta `develop`: enruta directo a la ruta de fallo explícita.
- Salida final: `status: failed`, y `review` contiene
  `FALLO EN ANALYZE (Kiro CLI): <detalle del error>`.
- El proceso termina con código de salida 1.

## Verificación rápida de Kiro CLI por separado

Si quieres probar solo la CLI, sin el grafo:
```bash
kiro-cli chat --no-interactive --trust-tools= "Responde solo: hola"
```
Debe imprimir `hola` y salir con código 0.

> Sintaxis verificada contra `kiro-cli chat --help` (v2.35.2): el prompt es el
> argumento posicional `[INPUT]`; `--trust-tools=` vacío = no confiar en ninguna
> herramienta (lo más seguro para `analyze`, que solo genera texto).

## Notas y limitaciones

- **Autenticación**: solo login SSO interactivo. La vía API key headless
  (`KIRO_API_KEY`) NO está disponible: la organización SSO corporativa tiene
  deshabilitada la gestión de API keys (requiere que un administrador la active).
- **Expiración de sesión**: la sesión SSO caduca cada cierto tiempo. Si la
  prueba empieza a fallar con errores de autenticación, vuelve a correr
  `kiro-cli login`.
- **Créditos**: cada llamada real consume créditos del plan de Kiro. Por eso la
  prueba es manual y opt-in.
- **Permisos**: `analyze` se invoca con `--trust-tools=` (vacío = ninguna
  herramienta). Nunca `--trust-all-tools`. Un rol que solo genera texto no
  necesita leer/escribir archivos ni ejecutar comandos.
- **Contexto del workspace**: `kiro-cli` corrido dentro del proyecto puede
  cargar el steering/agentes de `.kiro/` y sesgar la respuesta. Verificado: con
  `--trust-tools=` no ejecuta herramientas, pero el contexto del directorio
  influye. Para `analyze` esto es tolerable (genera un plan); si en el futuro
  molesta, correr la CLI desde un cwd neutral.
