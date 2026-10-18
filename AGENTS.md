# Agent Observer

Independent local project; do not mix its code, logs or dependencies into Enlace.

- Store metadata from an explicit allowlist only. Never log prompts, outputs, arguments, credentials or conversation content.
- Preserve bounded files, retention, private permissions and bounded review reads.
- Review findings are evidence-based heuristics, not proof of task quality or misconduct.
- Use no external model or service automatically. A review pack may be consumed by the user's existing agent.
- Pi integration must not change tool results or interrupt work when logging fails.
- Do not claim Codex, Claude, Grok or worker internals are captured by the Pi parent hook.
- Publication is authorized under MIT; never publish user logs, sessions, credentials, personal author metadata or local configuration. Keep provider adapters optional and the core provider-neutral.
