# Agent Observer

**See what your AI coding agents actually did (failed tools, slow calls, token budgets) from compact local metadata that never contains prompts, arguments or secrets.**

English · [Español](README.es.md)

![Animated demo: a log append drops a prompt and an API key, review reports repeated failures and a slow tool, and a credential-broker audit export is imported with zero duplicates on re-import.](docs/media/demo.gif)

<sub>Every terminal line in the demo is real CLI output on synthetic events and a fake key (review output is abridged). Regenerate: `node docs/media/capture.mjs ../agent-credential-broker && python3 docs/media/demo.py` (needs the sibling broker checkout with its venv, Pillow and ffmpeg).</sub>

## Why

Agent sessions are hard to audit after the fact: transcripts are huge and full of private data, and "the agent seemed slow" is not evidence. Observer keeps only an allow-listed record per event (time, event kind, opaque IDs, registered tool name, status, duration, token/cost counters), then applies a configurable, deterministic guide to produce findings with counted evidence. No model is called, nothing leaves your machine, and nothing changes permissions.

It is a local library and CLI, agnostic to the agent and the provider. Version 0.5 (package `0.5.1`) keeps a [neutral event contract with optional adapters](docs/schema.md); the 0.4 changes (privacy, correlation, recovery, reproducible results) are in [v0.4 improvements](docs/v0.4-improvements.md).

## Quick start

Requires Node.js 22.22 or later. The store, the CLI and the reviewer use only the standard library; the optional Pi integration uses TypeBox. The Codex and broker importers also need Linux and Python 3 with SQLite at `/usr/bin/python3`. Nothing installs services or models.

```sh
git clone https://github.com/Caelos-Palacio/agent-observer.git
cd agent-observer
npm ci --ignore-scripts
npm test

# Record a metadata event (unknown fields such as "prompt" are dropped), then review it.
node src/cli.mjs append '{"event":"tool_end","tool":"bash","status":"error","durationMs":912}' --directory ~/observer-logs
node src/cli.mjs review --directory ~/observer-logs
node src/cli.mjs pack --directory ~/observer-logs     # review + guide, for your existing agent to explain
```

`review` returns metrics and findings with counted evidence. `pack` adds an analysis guide so that the agent you already use can explain those findings; it sends nothing to a model or service. `--guide guide.json` adjusts the typed budgets (`node src/cli.mjs guide` prints the defaults), and `--directory` picks a private store (default `~/.local/state/agent-observer/logs`, or `AGENT_OBSERVER_DIR`).

### CLI reference

| Command | What it does |
|---|---|
| `review [--directory DIR] [--guide FILE]` | Metrics, findings and coverage as JSON |
| `pack [--directory DIR] [--guide FILE]` | The same report plus the guide and instructions for your agent |
| `append JSON [--directory DIR]` | Validate and store one metadata event (at most 16 KiB of input) |
| `recover --directory DIR` | Explicit, bounded recovery of a dead writer's lock and an incomplete log tail |
| `guide` | Print the active guide (default thresholds) |
| `import-codex --file JSONL --thread-id ID --database SQLITE` | Explicit experimental Codex token import |
| `import-broker-audit --file EXPORT_JSONL --database SQLITE` | Import an [Agent Credential Broker](https://github.com/Caelos-Palacio/agent-credential-broker) audit export |
| `review\|pack --source codex\|broker --database SQLITE` | Review an imported source instead of the Pi/SDK store |
| `evaluate-conformance --file METADATA_JSON` | Optional offline [conformance evaluation](#optional-conformance-evaluation) |

Current rules: repeated failures per agent/tool, observed concurrency, known depth, slow calls, and token/cost budgets when counters exist. These are operational signals. They do not prove poor quality, redundant work, semantic failures or exact billing. The smart part of the review is done by the agent that receives the report, which keeps its limitations and evidence.

## Features

- **Metadata only.** Time, event kind, opaque IDs (legacy SHA256 supported), registered tool identifier, status, duration and available counters. Unknown fields, prompts, arguments, responses, arbitrary errors and credentials are dropped. New identities are random per instance with in-memory correspondence only; legacy IDs remain correlatable. This is not guaranteed anonymity.
- **Bounded storage.** 2 KiB per event, 1 MiB per file, five previous files plus the current one; reads are capped at 10 MiB with a window of the latest 10000 events and explicit coverage/truncation. Cross-process rotation and locking. Files 0600 and directory 0700 on POSIX (Windows ACLs depend on the host). A fresh lock from a provably dead PID allows explicit bounded recovery; old or unverifiable locks need manual inspection. The log promises neither transactional durability nor a system sandbox.
- **Deterministic review.** Typed JSON thresholds, findings with sample sizes and coverage, no LLM judge.
- **Explicit importers.** Codex token usage and credential-broker audit exports, each read only from the file you name. See [Codex import](docs/codex-import.md) and [broker audit import](docs/broker-audit-import.md).
- **Pi extension.** Optional, disabled by default; see below.
- **SDK for other hosts.** Any host can emit the same schema through the SDK or `append`:

```js
import {createStore,review} from './src/index.mjs';
const store=createStore({directory:'/your/private/log-directory'});
await store.append({event:'tool_end',session:'local-session',agent:'main',tool:'read',status:'ok',durationMs:20});
console.log(await review(store.events()));
```

### Credential-broker audit, without vault access

The custodian exports metadata only, from its trusted environment. Observer receives that file; it gets no permission to read the vault, reach the socket or execute actions.

```sh
# In the custodian's environment; use an authorized exchange directory.
umask 077
agent-credential-broker audit-export --directory /private/custodian/dir > /authorized/exchange/audit-export.jsonl

# In Observer's environment, selecting the exported file explicitly.
node src/cli.mjs import-broker-audit --file /authorized/exchange/audit-export.jsonl --database /private/observer/broker.sqlite
node src/cli.mjs review --source broker --database /private/observer/broker.sqlite
node src/cli.mjs pack --source broker --database /private/observer/broker.sqlite
```

With different UIDs, the human hands over a sanitized copy owned by Observer's UID inside a private directory; this grants no access to the vault directory. The integration test uses a single UID and does not demonstrate isolation between users. The v1 contract accepts exactly seven fields; the optional v2 adds five correlation/chronology/sequence fields emitted by the custodian. Any extra property, password, argument or arbitrary state invalidates the whole batch. IDs are deduplicated in one transaction, so re-importing the same export adds zero events. At most 10000 events and 100000 dedup IDs are kept; beyond that new imports are rejected instead of silently forgetting IDs. Intent, execution and outcome are kept distinct, as are denial and an uncertain result. An uncertain result raises a signal to verify effects before retrying; Observer never authorizes a retry. V1 has no execution time or correlation (its date is the first import); v2 keeps the custodian's chronology and `executionId` with explicit coverage but does not authenticate the evidence. Sessions/agents, tokens and cost are unavailable. [Contract, limits and verification](docs/broker-audit-import.md). Broker v2 corrections of one execution are grouped by sequence in `review`/`pack` while the imported audit is kept intact: [rules and coverage](docs/broker-review-corrections.md).

### Codex import (experimental)

```sh
node src/cli.mjs import-codex --file /path/rollout.jsonl --thread-id ID --database /private/dir/codex.sqlite
node src/cli.mjs review --source codex --database /private/dir/codex.sqlite
```

It reads only the file you name and projects incremental token counters for that exact thread. SQLite stores the cursor, deduplication and events in one transaction; re-importing, truncating or rotating the file does not duplicate responses already observed. It copies no conversations and does not touch the Pi log. It does not capture Codex tools, agent relationships or costs; coverage marks them unavailable. Each worker/thread needs an explicit selection. [Format, limits and privacy](docs/codex-import.md).

### Pi and other agents

[The optional extension](docs/pi-integration.md) captures only the Pi processes that load it. It is enabled only when the host loads the extension and turns capture on; a launcher may explicitly integrate observations of workers from the parent. It installs no shims, configures no providers and modifies no other applications. It offers `agent_usage_review` so Pi can query the metrics and give a grounded critique. It does not claim to record the internal processes of Codex, Claude, Grok or other workers.

```sh
npm ci --ignore-scripts        # in this checkout; the extension needs its TypeBox dependency
AGENT_OBSERVER_ENABLED=1 AGENT_OBSERVER_DIR=/private/observer-logs \
  pi --extension /path/to/agent-observer/integrations/pi-observer.ts
```

There is no model, scheduled task, external upload or automatic permission change. The Pi module disables logging if the disk fails or the queue fills; `AGENT_OBSERVER_ENABLED=0` forces it off. The extension was checked to load with Pi 1.3.0. See also [Pi Session Workspace](https://github.com/Caelos-Palacio/pi-session-workspace) for session navigation in Pi.

## Limitations and security model

- Observer is not a sandbox and not tamper-evident. A process with your UID can read or alter the store; imported metadata and IDs prove nothing about authenticity.
- Metadata cannot show reasoning quality, task correctness, redundant work or exact bills. Always check coverage before drawing conclusions, and keep logs out of repositories.
- Event counters must be increments, not cumulative totals.
- POSIX local-filesystem concurrency is tested; Windows and network filesystems are not.
- Codex import is experimental because the log format is not a stable API; broker evidence covers only explicit host exports.

See the [review guide](docs/review-guide.md) for the storage limits, coverage fields and interpretation rules.

## Optional conformance evaluation

An offline [structured conformance evaluation](docs/conformance-evaluation.md) compares external rubric labels with metadata verdicts, using separate safety and utility components. It retains unknown coverage, runs offline and grants no permissions. Existing operational reviews remain unchanged. Try it with `npm run evaluate:conformance`.

## Related projects

- [Agent Credential Broker](https://github.com/Caelos-Palacio/agent-credential-broker): lets agents call authenticated APIs without seeing the key; exports the audit metadata this project imports.
- [Pi Session Workspace](https://github.com/Caelos-Palacio/pi-session-workspace): session navigation, checkpoints and a local mailbox for the Pi coding agent.

## License

[MIT](LICENSE)
