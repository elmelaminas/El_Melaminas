# Protocolo EXIT — EL MELAMINAS

Sistema de cierre de sesión que persiste el estado del proyecto en
`docs/SESION-ACTUAL.md` para que cualquier chat nuevo (en este o en otro
cliente: Antigravity, Claude.ai, ChatGPT, etc.) pueda retomar el trabajo
sin perder contexto.

## Cuándo se dispara

El protocolo se activa cuando Sergio escribe **una palabra sola** en el
chat:

- `exit`
- `Exit`
- `SALIR`

Cualquier otra forma (frase, pregunta, comando con argumentos) NO lo
dispara — para evitar falsos positivos cuando "exit" aparezca dentro de
una conversación normal.

## Qué hace el agente al recibir "exit"

1. **Actualiza `docs/SESION-ACTUAL.md`** con los siguientes cambios:
   - Campo `Última actualización:` con fecha + hora actuales (formato
     `YYYY-MM-DD HH:MM`).
   - Campo `Último commit` con la salida de `git log --oneline -1`.
   - Sección **`## Última acción realizada`** con un resumen breve
     (3–6 viñetas) de lo hecho en esta sesión.
   - Sección **`## Próxima acción sugerida`** con la siguiente tarea
     concreta para retomar (1–3 viñetas accionables).
   - Sección **`## Bugs / pendientes activos`** con cualquier issue
     conocido al cierre. Si no hay, escribir "Ninguno conocido al cierre."

2. **Commit + push**:

   ```bash
   git add docs/SESION-ACTUAL.md
   git commit -m "session: close - [resumen de 5 palabras]"
   git push origin main
   ```

   El `[resumen de 5 palabras]` es libre pero conciso, en imperativo
   español (ej: `add edit user modal flow`, `fix signed urls evidence`).

3. **Muestra a Sergio el mensaje exacto** para retomar en un nuevo chat,
   en un bloque de código copiable:

   ```
   Hola. Soy Sergio, continuando EL MELAMINAS. Lee docs/SESION-ACTUAL.md del repo
   https://github.com/elmelaminas/El_Melaminas y confírmame que entendiste el estado
   actual antes de continuar.
   ```

## Qué hace el agente al iniciar una sesión nueva

Cuando un chat empieza con ese mensaje (o cualquier variante que pida
"retomar EL MELAMINAS" / "leer SESION-ACTUAL"):

1. Leer `docs/SESION-ACTUAL.md` completo.
2. Resumir en 4–6 viñetas:
   - Último commit visto.
   - Última acción cerrada.
   - Próxima acción sugerida.
   - Bugs/pendientes activos (si hay).
3. Esperar instrucción concreta de Sergio antes de tocar código.

## Reglas

- **NUNCA modificar `docs/SESION-ACTUAL.md` fuera del protocolo EXIT.**
  Esto evita drift entre lo que el archivo dice y lo que realmente
  está commiteado. Excepción: al añadir una columna/módulo nuevo
  que pertenezca a las listas estables (módulos implementados,
  buckets, tablas) — esto SÍ se actualiza inline en la misma sesión.
- **Todo cambio en `SESION-ACTUAL.md` se commitea inmediatamente**
  con el formato `session: …` o `docs: …`.
- Si al recibir "exit" hay cambios sin commitear en el working tree,
  detener el protocolo, avisar a Sergio, y esperar instrucciones
  (commit / stash / discard) antes de continuar.

## Estructura del archivo SESION-ACTUAL.md

Bloques fijos (no se quitan):
- Encabezado con URLs y ruta local.
- Stack.
- Roles del sistema.
- Tablas Supabase.
- Columnas especiales en leads.
- Buckets de Storage.
- Módulos implementados.
- Reglas de comunicación con Sergio.

Bloques móviles (se actualizan en cada EXIT):
- `Última actualización`.
- `Último commit`.
- `Última acción realizada`.
- `Próxima acción sugerida`.
- `Bugs / pendientes activos`.
- `Próximas tareas pendientes` (lista a más largo plazo; se sincroniza
  con la "próxima acción" cuando se completa).
