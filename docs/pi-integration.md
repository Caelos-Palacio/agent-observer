# Pi integration

The optional extension records metadata about the Pi process that loads it. Logging is **disabled by default**. When disabled it registers no hooks or tools. When enabled it registers one read-only review tool and sends no data to external services.

Load the extension from its checkout with Pi's `--extension` option, or use the standard Pi extension configuration. Set these environment variables in the host process:

```sh
AGENT_OBSERVER_ENABLED=1
AGENT_OBSERVER_DIR=/your/private/log-directory
```

If no directory is supplied, the runtime uses `$HOME/.local/state/agent-observer/logs`. Keep this directory outside repositories. No extension is installed automatically.

Recorded fields are event time, random session/run identifiers, opaque host/worker identities, tool identifier, status, elapsed milliseconds, and available token/cost counters from assistant runs. Tool events contain timing and status only, preventing double counting of assistant usage. Pi's actual hooks are `session_start`, `session_shutdown`, `agent_start`, `agent_end`, `tool_call`, `tool_result`, and `message_end`. Assistant usage maps verified `usage.input`, `usage.output`, and `usage.cost.total` to the corresponding run counters. These counters may be absent, incomplete, or provider estimates; cache token counts are not included in the input/output figures.

The adapter does not serialize prompts, messages, arguments, outputs, models, API keys, original session IDs, working directories, error text, or file paths. It reads only assistant message role, stop reason, and usage metadata. Tool identifiers must belong to the trusted host registry. Store validation provides another allowlist and transforms host identities to opaque per-instance IDs before persistence.

Hooks enqueue at most 100 events and return immediately. Writes are sequential with a two-second deadline. A full queue or a storage failure disables logging for that process and displays at most one generic warning if interactive UI is available. It does not change tool results or block the agent. A timed-out filesystem operation cannot be forcibly cancelled and may finish after logging has stopped. A forced process exit can lose queued events.

## Interpretation limits

A `subagent` tool event records the observed delegation tool invocation; it does not prove how many workers ran or succeeded. Worker activity requires either explicit parent lifecycle hooks or the extension loaded in that worker; a delegation tool event alone provides no lifecycle evidence. Depth is established only by recorded parent relationships, not by environment labels. Independent extension sessions are intentionally not correlated; trusted parent lifecycle hooks retain their observed parent session. Nested tool calls are counted as individually observed calls, so their elapsed times can overlap.

Tool durations measure the interval between the observer's `tool_call` and `tool_result` hooks, including intervening extension work; they are not CPU time. An `agent_end` status is inferred only from observed assistant stop reasons. Session shutdown does not prove all tasks completed. No logging mechanism can certify an agent's reasoning quality or the correctness of its output.

## Local review tool

When enabled, the extension registers `agent_usage_review`. This read-only tool takes no arguments and processes the bounded metadata store using deterministic review rules. It makes no model calls. Pi can use its report to discuss failures, overlapping work, slow tools, and available usage figures; conclusions about reasoning or correctness still need evidence from the actual task. Queued events may not yet be visible. A parent may observe confirmed worker spawn/exit events through the optional trusted helper described below. Workers captured this way must not also log their own run usage, to avoid duplication.

Embedders may call `createObserver(pi, { enabled: true, directory, store })` from a trusted host shim. These are host configuration options, never tool parameters. `AGENT_OBSERVER_ENABLED=0` disables the integration even when the shim opts in.

## Parent-observed worker lifecycle

A trusted host integration may import `observeWorkerStart(name)` and call it only after the OS `spawn` event. It returns a one-shot handle with `end(status, usage?)`, or `undefined` when logging is disabled. Call `end` on confirmed process exit. Status accepts `ok`, `error`, `cancelled`, or `timeout`; usage accepts verified assistant counters `{input, output, cost: {total}}`. Omit counters when unavailable. No task text, process arguments, outputs, or paths are accepted. Worker names are ignored; the host generates an opaque worker identity. Start and end events share the parent session and identify the observed parent, allowing concurrency and depth review.

The parent must disable the separate observer in those child processes (`AGENT_OBSERVER_ENABLED=0`) if it records their run usage itself. Parent lifecycle observation does not capture child tool calls. Spawn failures before an OS `spawn` event are not represented as started workers. Repeated `end` calls do not create duplicate events.

Trusted embedders can supply `options.guide` for local review thresholds. The review tool includes the store snapshot's coverage, so a retained recent window is not presented as the entire history.
