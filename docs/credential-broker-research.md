# Optional credential broker research

Agent Observer contains no vault, credential getter, secret injection or authorization engine. Its core is provider-agnostic.

The independent [Agent Credential Broker](https://github.com/Caelos-Palacio/agent-credential-broker) contains its own implementation, threat model and research. It is not a runtime dependency of Observer. The optional metadata importer accepts only an explicit sanitized host export; see [broker audit contract](broker-audit-import.md).
