# Neutral event contract

The core SDK (`src/index.mjs`) exports `createStore`, `normalizeEvent`, `review`, `validateGuide`, and `DEFAULT_GUIDE`. It does not load a provider, credential configuration, other project, Pi extension or transcript automatically. It needs Node 22.22+ and standard libraries. TypeBox is used only by the optional Pi integration.

```js
import {createStore,review} from '../src/index.mjs';
const store=createStore({directory:'/your/private/events',registeredTools:['inventory','compile']});
await store.append({event:'tool_end',session:'host-session',agent:'worker',tool:'compile',status:'ok',durationMs:40});
const {events,coverage}=await store.snapshot();
const report=await review(events,{coverage});
```

A trusted host owns `registeredTools` (up to 256 names). Unknown names become `other`. Omit unavailable fields. Values in `session`, `agent`, `parent`, `taskId` are transformed to opaque per-store IDs; their bounded correspondence table is memory-only. New store instances intentionally do not reconstruct cross-run identity from arbitrary names.

## Fields

- `event`: `session_start`, `session_end`, `agent_start`, `agent_end`, `tool_start`, `tool_end`, `error`, `checkpoint`.
- `timestamp`: observation time, ISO8601. Defaults to current time for append.
- `session`, `agent`, `parent`, `taskId`: optional host identities transformed before storage.
- `tool`: identifier from a trusted host registry; no path, prompt or arbitrary label.
- `status`: `ok`, `error`, `cancelled`, `timeout`, `running`, `denied`, `uncertain`, `intent`.
- `durationMs`, `inputTokens`, `outputTokens`, `cost`: bounded nonnegative counters. Usage/cost must be **increments**, not repeated cumulative totals. Missing means unavailable; units/completeness belong to the producer.

V2 metadata additionally accepts `schemaVersion:2`, `eventId`, `requestId`, `producerId` (host-generated hexadecimal opaque IDs), positive `sequence`, `occurredAt` and `observedAt`. Optional fields remain optional: a schema label does not prove source completeness. A requestId correlates an observed call, not identity, permission or authority. A producerId describes the telemetry source, never a credential reference. Do not encode private content inside IDs.

Unknown properties are dropped by the generic normalizer. Optional adapters can enforce stricter producer contracts; for example, broker exports reject all unexpected properties. Review only consumes normalized metadata. It does not execute log contents, grant permissions or judge the semantic correctness of a task.

## Optional adapters

- `./adapters/codex` exposes the explicit experimental offline transcript-to-token projector. It requires `/usr/bin/python3` with SQLite on Linux and only reads the explicitly selected file/thread.
- `./adapters/broker` exposes explicit host metadata-export import/read APIs, without access to any vault or sibling source repository.
- `./integrations/pi` exposes an opt-in host extension; it requires Pi and TypeBox. Any existing host can emit the neutral contract without Pi.

The repository includes a cross-project smoke script solely for maintainers. Normal installation, `npm test`, and CI do not require Agent Credential Broker, Pi sessions, a provider account, a model or network calls beyond installing the pinned npm dependency. The synthetic benchmark bundles its old reference implementation rather than depending on private Git history.
