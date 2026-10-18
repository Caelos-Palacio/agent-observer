# Metadata review guide

The observer writes only allowlisted structured metadata. Prompts, arguments, outputs, arbitrary errors, credentials and paths are not stored. New session, agent, parent and task IDs become opaque random identifiers scoped to a store instance; legacy hashed IDs remain readable and linkable. Neither mechanism guarantees anonymity. Tool names must be short identifiers. Do not put personal data in tool names.

Use `createStore({directory})` with a dedicated private directory. `append(event)` is asynchronous. `snapshot()` returns `{events, coverage}` for the latest bounded window in storage order; review callers must include `coverage` in their output. `events()` is a compatibility async iterable over the same latest window, and does not carry coverage itself. Events use `event`, `timestamp`, `session`, `agent`, `parent`, `taskId`, `tool`, `status`, `durationMs`, `inputTokens`, `outputTokens`, and `cost`. Token and cost counters are **increments**. Recording repeated cumulative totals would double-count usage. Cost units must be consistent and supplied by the producer.

Event kinds are `session_start`, `session_end`, `agent_start`, `agent_end`, `tool_start`, `tool_end`, `error`, and `checkpoint`. Statuses are `ok`, `error`, `cancelled`, `timeout`, and `running`. Durations and failures are aggregated from `tool_end`. The producer must emit paired agent start/end events for concurrency estimates.

```json
{
  "version": 1,
  "thresholds": {
    "repeatedFailures": 3,
    "maxConcurrentAgents": 3,
    "maxDepth": 3,
    "slowToolMs": 30000,
    "maxSessionTokens": 100000,
    "maxSessionCost": 5
  }
}
```

`review(events, {guide})` accepts iterable or async iterable metadata and returns `metrics`, `findings`, `tools`, and `limitations`. Guides are typed JSON thresholds, not prompts or executable rules. Defaults apply to omitted thresholds. Unknown fields and nonpositive thresholds are rejected. Thresholds are operational budgets, not universal recommendations.

Findings report repeated failures, observed concurrency, known parent depth, slow calls, and recorded token/cost budgets. Every finding carries concrete counts. A slow tool is not proof of waste. Metadata does not establish correctness, task quality, prompt injection, safe behavior, or whether another model would perform better. Missing end events can inflate concurrency; absent counters are unavailable. Retention can omit the start of a session or parent chain. No external model is called.

Storage bounds: events up to 2 KiB; active file up to 1 MiB; five archives by default, configurable down to zero. The reader streams retained files through a ring buffer of at most 10,000 events, releases its lock, then returns the latest events. `coverage` includes `truncated`, `readBytes`, `readEvents`, `returnedEvents`, `eventLimit`, `byteLimit`, and `window: "latest-retained"`. More than 10,000 valid events produce a recent window with `truncated: true`, rather than disabling review. This coverage describes retained files; previously rotated-away history is unavailable even when `truncated` is false. The 10 MiB hard read limit (or a smaller configured limit), malformed logs, and files above 1 MiB remain explicit errors. File rotation uses renames protected by a nonempty-directory cross-process lock; it is not a transactional database and does not promise crash durability. A partial final line is rejected for manual inspection. New directory locks support explicit dead-owner recovery; any legacy `.writer.lock` requires manual inspection. Stop/restart all older writers before upgrading: mixed lock protocols are unsupported. POSIX local-filesystem concurrency was tested; Windows/network filesystems were not.

Directories must be private (0700 on POSIX), log files are 0600, and symlink/hardlink log files are rejected. These checks coordinate trusted local processes and do not defend against an adversary controlling the parent directory or replacing paths between checks. Windows ACLs are managed by the host. Never place the store in a publicly writable location or expose arbitrary store directories through a remote tool.

Version0.4 uses opaque per-instance identities for newly stored events and a host-owned registered-tools allowlist. Historical SHA256 IDs remain readable. Pi metadata v2 adds call/producer IDs, sequences and separate source/observation times; reports expose queue loss and uncertain persistence. `reviewVersion:2` adds rule/guide versions and evidence denominators. See [implementation details and measured limits](v0.4-improvements.md).
