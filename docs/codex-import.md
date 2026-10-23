# Experimental Codex importer

> Spanish original: [es/codex-import.md](es/codex-import.md)

Explicit local import: it scans no sessions, reads no other threads, sends no data and invokes no models. It requires Linux, `/usr/bin/python3` with SQLite, and Node 22 for the CLI. The Python API also works on its own.

```sh
node src/cli.mjs import-codex --file /path/rollout.jsonl --thread-id ID --database /private/dir/codex.sqlite
node src/cli.mjs review --source codex --database /private/dir/codex.sqlite
node src/cli.mjs pack --source codex --database /private/dir/codex.sqlite
/usr/bin/python3 src/codex_import.py read --database /private/dir/codex.sqlite
```

The immediate parent of the database can be created automatically; its ancestors must exist. Use an owned 0700 directory outside the repository. The database and auxiliary SQLite files must be regular, 0600, owned by you and without hardlinks. All paths are walked without following symlinks. The collector checks `application_id` in the header before opening SQLite; it validates version, tables, columns and primary keys over a read-only connection before opening a writer. `read` uses `mode=ro`, without initializing tables or changing persistent PRAGMAs. A pending rollback journal that needs recovery can prevent reading until the host recovers it through a controlled import; this is not a tool for reading arbitrary SQLite. It never prints the source path, original IDs, invalid lines or exceptions with contents. An administrator or process with the same UID and permissions can modify/read the store: it is not a boundary against that attacker.

## Projection

It accepts records with `type: token_usage_record` carrying `thread_id`, `response_id` and `usage` in `payload` (or in the record itself), and a `timestamp` **on the record itself** with an explicit time zone (a timestamp inside `payload` is counted as malformed). It requires an exact thread match; it does not deduce identity from `session_meta`, which avoids summing records inherited from a fork. It keeps only `input_tokens`/`output_tokens` (or `input`/`output`) as `inputTokens`/`outputTokens`, a normalized timestamp, the `checkpoint` type and SHA256 IDs truncated to 16 hex. The session corresponds to the thread and the agent to the label `codex-main`; this label does not show coverage of all agents.

It ignores `event_msg/token_count`, cumulative `thread_token_usage`/`turn_token_usage` counters and unknown fields. Cached and reasoning counts are subsets of the provider's counters: they are not added as extra tokens. It computes no prices and does not convert tokens into billing. Reading is experimental because the log format is not a stable API. In other formats records are skipped; fields are never guessed.

`coverage` declares `toolsCaptured:false`, `agentsCaptured:false`, `costAvailable:false`. A zero in metrics without coverage does not prove the absence of usage. Hashed IDs allow correlation and do not guarantee anonymity. The data is plaintext metadata, not an encrypted vault.

## Durability and limits

A single SQLite transaction records checkpoints, `(thread, response)` deduplication and the cursor `(hashed dev/inode, thread, offset, hashed anchors of the prefix and the last processed line)`. There is no second delivery JSONL, so there are no duplicates from failures between two stores. The cursor advances only over complete lines. A size smaller than the cursor, a new inode or a change in the anchors triggers a re-read; deduplication is preserved. The source is assumed append-only: an interior rewrite that preserves enough size, prefix and processed tail may go undetected. For arbitrary rewrites, move the file to a new inode before importing. A corrected response with the same ID does not silently replace the first observation.

Per-run limits: 1 MiB line, 32 MiB read plus two bounded anchor checks (up to 512 bytes each), 100000 records. Batch limits let it continue from the last complete record; an excessive line rolls back the entire batch. Invalid JSON is counted without storing fragments. It retains the latest 10000 checkpoints, 64 cursors and at most 100000 deduplicated responses; on reaching the deduplication limit the new transaction fails. Creating a new store resets that historical guarantee: do not mix its exports as if they were unique.

SQLite uses `DELETE` rollback journal, `synchronous=FULL` and 4096-byte pages, with a maximum of 8192 pages (~32 MiB for the database and comparable transient space for the journal). Opening rejects more than 64 MiB summing the database and auxiliary files; WAL is not used. It is not an unlimited-retention system nor a guarantee against physical corruption. The Node bridge runs Python with `-I` to isolate imports from the current directory and user-site; it limits stdout/stderr to 4 MiB and time to 30 s; external errors are constant. Reports keep their earlier 128 KiB limit.

## Review

`review` and `pack` accept only the projected database; they never accept transcript paths from Pi's public review tool. Import options belong to the host's CLI. The default review keeps using the Pi store and its typed guide. Concurrency and parent relations are separated by session; the token importer offers no evidence of those metrics. The report supports a critique by your existing agent; it contains no LLM judge of its own and does not evaluate semantic content.

Tests: growth, repetition, rotation, truncation, fork, wrong thread, partial line, invalid JSON, fields with synthetic secrets ignored, limits and rollback, permissions, symlinks/hardlinks, the full CLI and coverage of missing costs. In local validation a single file corresponding to the thread available in the test process's environment was selected; that does not establish capture of the root orchestrator or of other conversations.
