# Broker v2: review execution corrections without double counting

A broker can durably record an outcome and later append a higher-sequence correction after its final revocation/response guard fails. Two terminal audit records for the same `(producerId, executionId)` represent one observed execution, not two calls. `review --source broker` and `pack --source broker` therefore use a view that selects the terminal record with the greatest producer sequence for each valid v2 identity.

The importer, SQLite data and `readBrokerAudit()` remain unchanged: all original records are retained and available for audit. This projection does not alter broker responses, retry actions, grant permissions, or authenticate producer claims.

## Rules

- V2 identity requires a 32 hex producer ID, 64 hex execution/request ID and positive safe-integer sequence. Only `execute`/`outcome` terminal records are grouped. `intent` remains a checkpoint and contributes no completed call.
- A higher sequence wins even when imported records are reordered or executions interleave. Identity includes the producer, so identical request IDs from distinct producers remain distinct.
- Identical records at the final sequence collapse to one view. Import-observation timestamp may differ and is not an execution-semantic conflict; producer timestamps, status, tool, duration and available counters are compared.
- Conflicting records at the same greatest sequence produce **one ambiguous execution** with no status, duration or counters. The view does not invent provider status `uncertain`, choose a more favorable result, or count the conflict twice. CLI includes an explicit limitation.
- V1 and invalid/incomplete identities retain their terminal records without speculative deduplication. Their count describes uncorrelated terminal metadata, not a verified provider execution count.
- Unknown source coverage disables normalization. IDs, statuses and sequences never become authority.

`coverage.brokerReview` reports applied/version, raw/reviewed event counts, correlated execution groups, corrected groups, superseded records, identical final duplicates, ambiguous groups and uncorrelated terminals. `rawReturnedEvents` preserves the raw window size; `returnedEvents` describes the projected view. `finalStatusComplete` refers only to eligible retained groups and is null when no terminal evidence exists. Raw sequence gaps, timestamps and original source coverage remain available with `sourceCoverageBasis:raw-retained-audit-metadata`; their counters retain the raw denominator. `brokerReview.coverageBasis` names the normalized terminal-execution view.

Selection uses the producer sequence inside each execution; output group position follows its first retained terminal record. It does not establish a global execution chronology or a total order across producers. An earlier correction outside the retained window is unavailable; the view cannot recover events that were never captured or prove complete history.

Tests cover success corrected to denied/uncertain, interleaved/reordered executions, producer boundaries, identical/conflicting sequence ties, v1, missing/invalid IDs, intents-only and unknown coverage. CLI regression imports real synthetic v2 DTOs, checks review/pack count one, then verifies the raw API still returns both records.

## Optional SDK adapter

`./adapters/broker` exports both `readBrokerAudit` (all raw imported metadata) and `brokerReviewSnapshot` (pure review projection). SDK callers should apply the view explicitly before operational review:

```js
import {readBrokerAudit,brokerReviewSnapshot} from '../src/broker.mjs';
import {review} from '../src/index.mjs';
const raw=await readBrokerAudit({database:'/your/private/broker.sqlite'});
const view=brokerReviewSnapshot(raw);
const report=await review(view.events,{coverage:view.coverage});
```

No source is enabled automatically and the neutral core does not import this adapter.
