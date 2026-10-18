# Agent Observer

Biblioteca y CLI locales, agnósticas del agente y proveedor, para registrar metadatos compactos y revisarlos con una guía configurable. Licencia [MIT](LICENSE).

Versión0.5 mantiene el [contrato neutral y adaptadores optativos](docs/schema.md). Mejoras de0.4: [privacidad, correlación, recuperación y resultados reproducibles](docs/v0.4-improvements.md).

## Uso

Requiere Node.js22.22 o posterior. La integración opcional de Pi usa TypeBox; el almacén, CLI y revisor usan bibliotecas estándar. Los importadores de Codex y auditoría del broker necesitan Linux y Python3 con SQLite en `/usr/bin/python3`; no instala servicios ni modelos.

```sh
npm ci --ignore-scripts
node src/cli.mjs review
node src/cli.mjs pack
node src/cli.mjs guide
npm test
```

`review` devuelve métricas y hallazgos con evidencia contada. `pack` añade una guía de análisis para que tu agente existente explique esos hallazgos; no envía datos a un modelo o servicio. `--guide guia.json` permite ajustar presupuestos tipados. `--directory` elige un almacén privado diferente.

Reglas actuales: fallos repetidos por agente/herramienta, concurrencia observada, profundidad conocida, llamadas lentas y presupuestos de tokens/coste cuando hay contadores. Son señales operativas: no demuestran mala calidad, trabajo redundante, fallos semánticos o facturación exacta. La revisión inteligente la realiza el agente que recibe el informe, conservando las limitaciones y evidencia.

## Importación explícita de Codex

```sh
node src/cli.mjs import-codex --file /ruta/rollout.jsonl --thread-id ID --database /directorio/privado/codex.sqlite
node src/cli.mjs review --source codex --database /directorio/privado/codex.sqlite
node src/cli.mjs pack --source codex --database /directorio/privado/codex.sqlite
```

Lee solamente el archivo indicado y proyecta contadores incrementales del hilo exacto. SQLite guarda cursor, deduplicación y eventos en una transacción; reimportar, truncar o rotar el archivo no duplica respuestas ya observadas. No copia conversaciones ni cambia el registro de Pi. No captura herramientas, relaciones entre agentes ni costes de Codex: la cobertura los marca como no disponibles. Cada worker/hilo requiere una selección explícita. [Formato, límites y privacidad](docs/codex-import.md).

## Auditoría del broker, sin acceso a la bóveda

El custodio exporta exclusivamente metadatos desde su entorno confiable. Observer recibe ese archivo; no recibe permisos para leer la bóveda, acceder al socket ni ejecutar acciones.

```sh
# En el entorno del custodio; usar un directorio de intercambio autorizado.
umask 077
agent-credential-broker audit-export --directory /ruta/privada/custodio > /intercambio/autorizado/audit-export.jsonl

# En el entorno de Observer, seleccionando explícitamente el archivo exportado.
node src/cli.mjs import-broker-audit --file /intercambio/autorizado/audit-export.jsonl --database /ruta/privada/observer/broker.sqlite
node src/cli.mjs review --source broker --database /ruta/privada/observer/broker.sqlite
node src/cli.mjs pack --source broker --database /ruta/privada/observer/broker.sqlite
```

Para procesos con UIDs diferentes, el humano entrega una copia saneada del exportado que pertenezca al UID de Observer, dentro de un directorio privado; no concede acceso al directorio de la bóveda. La prueba de integración usa el mismo UID y no demuestra aislamiento entre usuarios.

El contrato v1 acepta exactamente siete campos; v2 optativo añade cinco campos de correlación/cronología/secuencia emitidos por el custodio. Una propiedad extra, contraseña, argumento o estado arbitrario invalida el lote completo. Deduplica IDs persistentes en una transacción; reimportar el mismo exportado añade cero eventos. Guarda como máximo10000eventos y100000IDs de deduplicación, tras lo que rechaza nuevas importaciones en vez de olvidar IDs silenciosamente. La base del broker usa una identidad distinta de la base de Codex, con el mismo validador de almacenamiento privado.

Distingue intención, ejecución y resultado, así como denegación y resultado incierto. Un resultado incierto genera una señal para verificar efectos antes de reintentar; Observer nunca autoriza el reintento. V1 no tiene hora de ejecución ni correlación: su fecha representa la primera importación. V2 conserva la cronología y executionId que emite el custodio, con cobertura explícita; no autentica la evidencia. Tampoco identifica sesiones/agentes ni proporciona tokens/costes. [Contrato, límites y verificación](docs/broker-audit-import.md).

Las vistas `review`/`pack` de broker v2 agrupan correcciones de una misma ejecución por su secuencia; la auditoría importada se conserva íntegra. [Reglas y cobertura](docs/broker-review-corrections.md).

## Qué guarda

Hora, tipo de evento, IDs opacos (históricos SHA256 compatibles), identificador registrado de herramienta, estado, duración y contadores disponibles. Descarta campos desconocidos, prompts, argumentos, respuestas, errores arbitrarios y credenciales. No conserva las conversaciones para revisarlas semánticamente. Las identidades nuevas son aleatorias por instancia, con correspondencias únicamente en memoria; las históricas siguen siendo correlacionables. No es anonimato garantizado.

Límites: 2KiB/evento, 1MiB/archivo, cinco archivos anteriores además del actual; lectura máxima10MiB, con ventana de los últimos10000eventos y cobertura/truncamiento explícitos. Rotación y bloqueo entre procesos. Archivos0600 y directorio0700 en POSIX; en Windows los ACL dependen del anfitrión. Un lock nuevo de un PID demostrado muerto admite recuperación explícita acotada; los locks antiguos o inverificables requieren inspección manual. El registro no promete durabilidad transaccional ni sandbox del sistema.

## Pi y otros agentes

[La extensión opcional](docs/pi-integration.md) captura únicamente los procesos Pi donde se carga. Se habilita solo cuando el anfitrión carga la extensión y activa la captura; un lanzador puede integrar explícitamente observaciones de workers desde el padre. No instala shims, configura proveedores ni modifica otras aplicaciones. Ofrece `agent_usage_review` para que Pi consulte métricas y haga una crítica fundamentada. No afirma registrar los procesos internos de Codex, Claude, Grok u otros workers. Otros anfitriones pueden producir el mismo esquema mediante el SDK o `append`.

```js
import {createStore,review} from './src/index.mjs';
const store=createStore({directory:'/your/private/log-directory'});
await store.append({event:'tool_end',session:'local-session',agent:'main',tool:'read',status:'ok',durationMs:20});
console.log(await review(store.events()));
```

No hay modelo, tarea programada, envío externo ni cambio automático de permisos. El módulo de Pi desactiva el registro si falla el disco o se llena la cola; `AGENT_OBSERVER_ENABLED=0` fuerza su desactivación.

[Guía y límites](docs/review-guide.md). Mantén los logs fuera de repositorios y revisa la cobertura antes de sacar conclusiones.
