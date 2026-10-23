# Importador experimental de Codex

Importación local y explícita, sin escanear sesiones, leer otros hilos, enviar datos ni invocar modelos. Requiere Linux, `/usr/bin/python3` con SQLite y Node 22 para la CLI. La API Python también funciona por separado.

```sh
node src/cli.mjs import-codex --file /ruta/rollout.jsonl --thread-id ID --database /directorio/privado/codex.sqlite
node src/cli.mjs review --source codex --database /directorio/privado/codex.sqlite
node src/cli.mjs pack --source codex --database /directorio/privado/codex.sqlite
/usr/bin/python3 src/codex_import.py read --database /directorio/privado/codex.sqlite
```

El padre inmediato de la base puede crearse automáticamente; sus ancestros deben existir. Usa un directorio propio 0700 fuera del repositorio. Base y archivos SQLite auxiliares deben ser regulares 0600, propios y sin hardlinks. Todas las rutas se recorren sin seguir symlinks. El recolector comprueba `application_id` en la cabecera antes de abrir SQLite; valida versión, tablas, columnas y claves primarias mediante una conexión de solo lectura antes de abrir un escritor. `read` utiliza `mode=ro`, sin inicializar tablas ni cambiar PRAGMAs persistentes. Un rollback journal pendiente que requiera recuperación puede impedir la lectura hasta que el anfitrión lo recupere mediante una importación controlada; no es una herramienta para leer SQLite arbitrario. No imprime la ruta de origen, IDs originales, líneas inválidas ni excepciones con contenidos. Un administrador o proceso con el mismo UID y permisos puede modificar/leer el almacén: no es una frontera frente a ese atacante.

## Proyección

Acepta registros `type: token_usage_record` con campos en `payload` o en el registro mismo: `thread_id`, `response_id`, `usage` y `timestamp`. Exige coincidencia exacta del hilo; no deduce identidad de `session_meta`, evitando sumar registros heredados de un fork. Solo conserva `input_tokens`/`output_tokens` (o `input`/`output`) como `inputTokens`/`outputTokens`, timestamp normalizado, tipo `checkpoint` e IDs SHA256 truncados a 16 hex. La sesión corresponde al hilo y el agente a la etiqueta `codex-main`; esta etiqueta no demuestra cobertura de todos los agentes.

Ignora `event_msg/token_count`, contadores acumulados `thread_token_usage`/`turn_token_usage` y campos desconocidos. Cached y reasoning son subconjuntos de los contadores del proveedor: no se suman como tokens adicionales. No calcula precios ni convierte tokens en facturación. La lectura es experimental porque el formato de logs no es una API estable. En formatos distintos se omiten registros; no se intenta adivinar campos.

`coverage` declara `toolsCaptured:false`, `agentsCaptured:false`, `costAvailable:false`. Un cero en métricas sin cobertura no acredita ausencia de uso. Los IDs hasheados permiten correlación y no garantizan anonimato. Los datos son metadatos en claro, no una bóveda cifrada.

## Durabilidad y límites

Una sola transacción SQLite registra checkpoints, deduplicación `(hilo, respuesta)` y cursor `(dev/inode hasheado, hilo, offset, anclas hasheadas de prefijo y final procesado)`. No existe un segundo JSONL de entrega, por lo que no hay duplicados por fallos entre dos almacenes. El cursor avanza únicamente sobre líneas completas. Un tamaño menor que el cursor, un nuevo inode o un cambio de las anclas provocan relectura; la deduplicación se conserva. La fuente se supone append-only: una reescritura interior que conserve tamaño suficiente, prefijo y final procesado puede no detectarse. Para reescrituras arbitrarias mueve el archivo a un inode nuevo antes de importar. Una respuesta corregida con el mismo ID no reemplaza silenciosamente la primera observación.

Límites por ejecución: línea 1 MiB, lectura 32 MiB más dos comprobaciones acotadas de anclas (hasta 512 bytes cada una), 100000 registros. Los límites de lote permiten continuar desde el último registro completo; una línea excesiva revierte el lote entero. JSON inválido se cuenta sin guardar fragmentos. Retiene los últimos 10000 checkpoints, 64 cursores y como máximo 100000 respuestas deduplicadas; al alcanzar el límite de deduplicación falla la nueva transacción. Crear un almacén nuevo reinicia esa garantía histórica: no mezcles sus exportaciones como si fueran únicas.

SQLite usa rollback journal `DELETE`, `synchronous=FULL` y páginas 4096 bytes, con máximo 8192 páginas (~32 MiB para la base y espacio transitorio comparable para journal). La apertura rechaza más de 64 MiB sumando base y archivos auxiliares; no se usa WAL. No es un sistema de retención ilimitada ni una garantía ante corrupción física. El puente Node ejecuta Python con `-I` para aislar imports del directorio actual y user-site; limita stdout/stderr a 4 MiB y tiempo a 30 s; los errores externos son constantes. Los informes mantienen su límite anterior de 128 KiB.

## Revisión

`review` y `pack` aceptan exclusivamente la base proyectada; nunca admiten rutas de transcripciones desde la herramienta pública de revisión de Pi. Las opciones de importación pertenecen a la CLI del anfitrión. La revisión predeterminada sigue usando el almacén Pi y su guía tipada. Concurrencia y relaciones parentales se separan por sesión; el importador de tokens no ofrece evidencia de esas métricas. El informe facilita una crítica del agente existente, no contiene un juez LLM propio ni evalúa contenido semántico.

Pruebas: crecimiento, repetición, rotación, truncamiento, fork, hilo incorrecto, línea parcial, JSON inválido, campos con secretos sintéticos ignorados, límites y rollback, permisos, symlinks/hardlinks, CLI completa y cobertura de costes ausentes. En la validación local se seleccionó un único archivo correspondiente al hilo disponible en el entorno del proceso de prueba; eso no acredita captura del orquestador raíz ni de otras conversaciones.
