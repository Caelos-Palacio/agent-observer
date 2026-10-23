# Importación de auditoría del custodio

Observer y Agent Credential Broker siguen siendo proyectos independientes. Su conexión es un archivo de metadatos exportado por el humano/custodio y seleccionado explícitamente por el consumidor. No hay dependencia de autorización, descubrimiento automático de bóvedas ni proceso que ejecute acciones a partir de hallazgos.

## Contrato v1

Un objeto JSON por línea, terminado en salto de línea, con **exactamente** estas propiedades:

```json
{"schemaVersion":1,"source":"agent-credential-broker","eventId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"execute","actionIdHash":"bbbbbbbbbbbbbbbb","status":"ok","durationMs":25}
```

- `eventId`: 64 caracteres hexadecimales minúsculos; los eventos nuevos del productor tienen un ID aleatorio persistido en la auditoría. Para registros antiguos sin ID, el exportador deriva uno del archivo/posición/contenido: ese fallback sobrevive a renombrar el mismo inode, pero puede cambiar al copiarlo. Observer no corrige esa limitación histórica.
- `actionIdHash`: 16 caracteres hexadecimales; no se exporta el ID ni alias de la credencial. Los hashes de identificadores de baja entropía pueden correlacionarse o adivinarse: esto no garantiza anonimato.
- `event`: `execute`, `intent` u `outcome`. Solo `intent` permite `status:intent`; los demás estados son `ok`, `denied`, `uncertain`.
- `durationMs`: entero entre 0 y 60000. El productor limita este contador; no mide tiempo facturable.

Rechaza propiedades adicionales, claves duplicadas, versiones/fuentes distintas, estados arbitrarios y tipos inválidos. No descarta silenciosamente campos sensibles de un DTO: falla el lote antes de crear un escritor. Los errores de CLI son constantes y no reproducen contenido ni rutas suministradas.

No leer archivos de auditoría raw ni archivos de la bóveda mediante este importador. El formato raw del custodio no coincide con este contrato y se rechaza. Un archivo válido puede ser fabricado por quien tenga acceso a la ruta: validación y hashes no prueban autenticidad criptográfica, ni que una acción realmente ocurrió. Conserva el exportado en un canal privado autorizado por el custodio. Si ambos procesos tienen UIDs diferentes, un humano debe entregar una copia saneada propiedad del UID de Observer en su directorio privado; compartir el archivo original por grupo no satisface el control de propietario. No concedas al agente acceso al directorio de la bóveda. La prueba sintética usa un solo UID y no demuestra este aislamiento operativo.

## Persistencia y eficiencia

Una importación lee únicamente el archivo indicado, sin enlaces simbólicos/hardlinks ni archivos especiales, propiedad del UID lector. Máximo 2 MiB, 4096 bytes por línea y 10000 registros por lote. Lectura acotada aunque el archivo crezca. No ejecuta plugins ni comandos aportados por el archivo.

SQLite conserva solo hora de primera importación, etapa, hash de acción, estado, duración y hashes de IDs deduplicados con namespace del productor. Deduplicación y escritura se confirman en una sola transacción; un lote inválido o que exceda capacidad no avanza el estado. Releer el exportado bounded es intencional: evita depender de offsets de una copia y conserva deduplicación a través de copias/rotaciones para IDs nuevos persistentes.

Se reutiliza la validación de almacenamiento de Codex: directorio propietario 0700 sin enlaces en ancestros, base y sidecars 0600, archivos regulares de un enlace, identidad SQLite y esquema exactos antes de abrir escritor. El lector usa descriptores y conexiones de solo lectura; rechaza incluso bases vacías o extranjeras sin modificarlas. La identidad del almacén broker difiere de Codex; no se mezclan contadores o tablas.

Retiene los últimos 10000 eventos y hasta 100000 IDs de deduplicación; bases/sidecars tienen comprobación de tamaño 64 MiB y páginas de escritura limitadas a 32 MiB. La deduplicación tiene un límite deliberado: al alcanzarlo se requiere crear una base nueva explícita o archivar la anterior, perdiéndose comparación automática con los IDs de aquella base. No promete retención infinita.

## Lectura e interpretación

`review --source broker --database SQLITE` y `pack` no acceden al exportado ni a la bóveda. `intent` se proyecta como checkpoint y no aumenta llamadas terminadas; `execute/outcome` aumentan llamadas observadas. `deniedToolCalls` y `uncertainToolCalls` son métricas separadas de errores técnicos. Un resultado incierto aconseja comprobar efectos; no dispara reintentos ni cambios de permisos.

El contrato v1 no captura timestamp de ejecución, sesión, principal seudónimo ni requestId. Su cobertura marca estos campos como no disponibles; `timestamp` corresponde a `first-import-observed-at`, nunca a cronología original. V1 tampoco permite relacionar una intención con su resultado ni detectar exactamente acciones incompletas. El contrato v2 optativo sí conserva ejecución/correlación emitidas por el productor; consultar su cobertura y los límites de la sección v2. Los contadores de tokens y coste están ausentes, y cero cobertura no significa cero consumo.

## Verificación

```sh
npm test
# Opcional: requiere el otro proyecto y su entorno Python, sin credenciales reales.
node scripts/smoke-broker-integration.mjs /ruta/agent-credential-broker
```

El segundo comando crea un AuditLog real con datos inventados, exporta, importa y revisa; reimporta para verificar cero duplicados y busca un marcador sensible ficticio en la base. No abre una bóveda, servicios ni interfaz. Las suites incluyen rollback, límites, claves duplicadas, archivos/base ajenos, lectura realmente RO y errores sin eco de valores privados. Estas pruebas no demuestran aislamiento frente a procesos maliciosos del mismo UID ni reemplazan una revisión de seguridad independiente.

## Opt-in v2

The importer also accepts the exact 12-field v2 contract: v1 fields plus executionId 64 hex, sequence positive integer, producerId 32 hex and occurredAtUTC/observedAtUTC in UTC millisecond format. Export with `audit-export --directory DIR --schema-version 2`. Legacy exports retain their missing-data coverage; v2 captures source timing/correlation, never authorization or authenticated provenance. See [v0.4 compatibility, migration and limits](v0.4-improvements.md).
