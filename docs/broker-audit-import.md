# Importing the broker's audit export

> Spanish original: [es/broker-audit-import.md](es/broker-audit-import.md)

Observer and [Agent Credential Broker](https://github.com/Caelos-Palacio/agent-credential-broker) remain independent projects. Their only connection is a metadata file exported by the human/custodian and explicitly selected by the consumer. There is no authorization dependency, no automatic vault discovery, and no process that executes actions based on findings.

## Contract v1

One JSON object per line, terminated by a newline, with **exactly** these properties:

```json
{"schemaVersion":1,"source":"agent-credential-broker","eventId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"execute","actionIdHash":"bbbbbbbbbbbbbbbb","status":"ok","durationMs":25}
```

- `eventId`: 64 lowercase hexadecimal characters. New events from the producer have a random ID persisted in the audit. For old records without an ID, the exporter derives one from file/position/content: that fallback survives renaming the same inode but may change when the file is copied. Observer does not fix that historical limitation.
- `actionIdHash`: 16 hexadecimal characters; neither the action ID nor the credential alias is exported. Hashes of low-entropy identifiers can be correlated or guessed: this does not guarantee anonymity.
- `event`: `execute`, `intent` or `outcome`. Only `intent` allows `status:intent`; the other statuses are `ok`, `denied`, `uncertain`.
- `durationMs`: integer between 0 and 60000. The producer bounds this counter; it does not measure billable time.

Additional properties, duplicate keys, other versions/sources, arbitrary statuses and invalid types are rejected. A DTO's sensitive fields are not silently discarded: the whole batch fails before a writer is created. CLI errors are constant and do not echo supplied content or paths.

Do not read raw audit files or vault files through this importer. The custodian's raw format does not match this contract and is rejected. A valid file can be forged by anyone with access to its path: validation and hashes prove neither cryptographic authenticity nor that an action really happened. Keep the export in a private channel authorized by the custodian. If the two processes run under different UIDs, a human must hand over a sanitized copy owned by Observer's UID in its private directory; sharing the original file via a group does not satisfy the owner check. Do not give the agent access to the vault directory. The synthetic test uses a single UID and does not demonstrate this operational isolation.

## Persistence and efficiency

An import reads only the indicated file: no symlinks/hardlinks or special files, and it must be owned by the reader's UID. Maximum 2 MiB, 4096 bytes per line and 10000 records per batch. Reading is bounded even if the file grows. It runs no plugins or commands supplied by the file.

SQLite keeps only the first-import time, stage, action hash, status, duration and hashes of deduplicated IDs namespaced by the producer. Deduplication and writing are committed in a single transaction; an invalid batch, or one that exceeds capacity, does not advance state. Re-reading the bounded export is intentional: it avoids depending on offsets of a copy and preserves deduplication across copies/rotations for new persistent IDs.

Codex's storage validation is reused: an owner-only 0700 directory with no links among ancestors, 0600 database and sidecars, regular single-link files, and exact SQLite identity and schema before a writer is opened. The reader uses read-only descriptors and connections; it rejects even empty or foreign databases without modifying them. The broker store's identity differs from Codex's; counters and tables are never mixed.

It keeps the latest 10000 events and up to 100000 deduplication IDs; databases/sidecars are checked against a 64 MiB size and write pages are limited to 32 MiB. Deduplication has a deliberate limit: on reaching it you must create an explicit new database or archive the old one, losing automatic comparison with that database's IDs. Infinite retention is not promised.

## Reading and interpretation

`review --source broker --database SQLITE` and `pack` access neither the export nor the vault. `intent` is projected as a checkpoint and does not increase finished calls; `execute/outcome` increase observed calls. `deniedToolCalls` and `uncertainToolCalls` are metrics separate from technical errors. An uncertain result advises checking effects; it triggers no retries or permission changes.

Contract v1 captures no execution timestamp, session, pseudonymous principal or requestId. Its coverage marks these fields as unavailable; `timestamp` corresponds to `first-import-observed-at`, never the original chronology. V1 also does not allow relating an intent to its outcome or detecting incomplete actions exactly. The optional v2 contract does keep the execution/correlation emitted by the producer; see its coverage and the limits in the v2 section. Token and cost counters are absent, and zero coverage does not mean zero consumption.

## Verification

```sh
npm test
# Optional: needs the other project and its Python environment, no real credentials.
node scripts/smoke-broker-integration.mjs /path/to/agent-credential-broker
```

The second command creates a real AuditLog with invented data, exports, imports and reviews; it re-imports to verify zero duplicates and searches the database for a fictitious sensitive marker. It opens no vault, service or interface. The suites include rollback, limits, duplicate keys, foreign files/databases, truly read-only reads, and errors that do not echo private values. These tests do not demonstrate isolation against malicious processes of the same UID and do not replace an independent security review.

## Opt-in v2

The importer also accepts the exact 12-field v2 contract: v1 fields plus `executionId` (64 hex), `sequence` (positive integer), `producerId` (32 hex) and `occurredAtUTC`/`observedAtUTC` in UTC millisecond format. Export with `audit-export --directory DIR --schema-version 2`. Legacy exports retain their missing-data coverage; v2 captures source timing/correlation, never authorization or authenticated provenance. See [v0.4 compatibility, migration and limits](v0.4-improvements.md).
