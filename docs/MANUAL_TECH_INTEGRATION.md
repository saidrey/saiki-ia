# Prueba manual de integración real — HU + Análisis técnico (Fases 9-10)

Valida de punta a punta, con **Kiro real** (sin mocks), el flujo de HU y análisis
técnico, para que un humano inspeccione la CALIDAD de la salida real. Es opt-in:
NO forma parte de `npm test`.

## Prerrequisitos

```bash
kiro-cli --version        # instalado (p. ej. 2.35.2)
kiro-cli login            # sesión SSO activa (necesaria; la CLI falla sin ella)
nvm use 22
```

## Ejecutar

```bash
npm run manual:tech
```

Es interactivo. Pasos:
1. Te pide una **solicitud de HU** en texto libre (Enter usa el ejemplo por defecto).
2. Kiro genera la **HU estructurada** y se muestra completa.
3. Decides: `approve` / `revise` / `reject`.
   - `revise` pide feedback y Kiro regenera una versión nueva (hasta el límite).
   - `reject` termina sin análisis técnico.
4. Solo si **apruebas**, Kiro ejecuta el **análisis técnico** (solo lectura) y se
   muestra el informe completo.

## Cómo interpretar los resultados

**HU (paso 2):** revisa que el resumen, las tareas y los criterios de aceptación
tengan sentido para tu solicitud. La calidad la juzgas tú; que el script termine
sin error NO significa que la HU sea buena.

**Análisis técnico (paso 4):** incluye resumen, flujo actual, archivos afectados,
cambios propuestos, trazabilidad con la HU, dependencias, riesgos y preguntas.
- Cada archivo afectado se marca **EXISTE** o **NO VERIFICADO/NUEVO** (verificado
  en disco).
- Al final se listan las **rutas no verificables/inexistentes** (reportadas, no
  inventadas). Si todas se verificaron, lo indica.

**Integridad:** al final confirma que el repositorio quedó **INTACTO** (acceso de
solo lectura; el análisis nunca escribe código).

**Errores:** si Kiro no está disponible, falla o devuelve algo que no cumple el
esquema, el script termina con **error explícito** (sin mock ni fallback).

**Evidencia:** toda la salida se guarda en un `.log` dentro de un directorio
temporal (la ruta se imprime al final). No contiene secretos ni credenciales.

## Qué NO demuestra

Una ejecución exitosa demuestra que el FLUJO funciona (genera, valida, verifica
rutas, no escribe), NO que el análisis sea correcto o completo: eso lo juzga el
humano al leer el informe.

## Nota de diseño (hallazgo real)

Al ejecutar con una HU de UI ("botón azul que suma a+b") sobre este repo (un
orquestador sin frontend), Kiro concluyó correctamente que la HU no mapea a
ningún archivo existente y devolvió `affectedFiles`/`proposedChanges` vacíos con
la explicación en summary/riesgos/preguntas. Esto reveló que el esquema era
demasiado rígido (exigía ≥1 archivo). Se relajó: esas listas pueden estar vacías
si el análisis explica por qué. Un análisis legítimo puede concluir "no
implementable aquí tal cual" sin ser un error.

## Aislamiento / seguridad

- Solo lectura (`--trust-tools=fs_read`). No escribe en el repo.
- El checkpointer SQLite de la corrida va a un directorio temporal (no deja
  estado de prueba en `.saiki/`).
- Los tests automáticos (`npm test`) NO dependen de Kiro/SSO; siguen usando mocks.
