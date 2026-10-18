import { randomUUID, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { performance } from 'node:perf_hooks';

const workerChannel = Symbol.for('agent-observer.pi-worker-channel.v1');

export function isWorkerObservationEnabled() {
  return process.env.AGENT_OBSERVER_ENABLED !== '0' && Boolean(globalThis[workerChannel]?.enabled());
}

/** Called by a trusted parent process after the OS confirms a worker spawn. */
export function observeWorkerStart(name = 'worker') {
  if (process.env.AGENT_OBSERVER_ENABLED === '0') return undefined;
  return globalThis[workerChannel]?.start(name);
}

/** Optional Pi extension. Handlers only copy an explicit metadata allowlist. */
export function createObserver(pi, options = {}) {
  const env = options.env ?? process.env;
  if (env.AGENT_OBSERVER_ENABLED === '0' || !(options.enabled ?? env.AGENT_OBSERVER_ENABLED === '1')) {
    delete globalThis[workerChannel];
    return { enabled: false, flush: async () => {} };
  }
  const directory = options.directory ?? env.AGENT_OBSERVER_DIR ?? join(homedir(), '.local', 'state', 'agent-observer', 'logs');
  const agent = randomBytes(16).toString('hex');
  const producerId=randomBytes(16).toString('hex');
  let sequence=0,droppedEvents=0,evictedCorrelations=0,unconfirmedEvents=0;
  let disableReason;
  const registeredTools=new Set(options.registeredTools??['read','write','edit','bash','grep','find','ls','web_search','browser_read','api_request','interface_driver','app_bridge','youtube','rea','github_read','subagent','cli_worker','harness_run','skills_audit','agent_usage_review','orchestrator_protocol']);
  let session = randomUUID();
  let taskId;
  let started;
  let tokens = {};
  let runStatus = 'ok';
  let disabled = false;
  let notified = false;
  let ui;
  let pumping;
  let store;
  const queue = [];
  const calls = new Map();
  const ready = Promise.resolve().then(async () => options.store ?? (await import('../src/store.mjs')).createStore({ directory,registeredTools:[...registeredTools] })).then(value => { store = value; }, disable);

  function disable(reason='storage-unavailable') {
    if(!disabled){droppedEvents+=queue.length;disableReason=typeof reason==='string'?reason:'storage-unavailable';}
    disabled = true;
    queue.length = 0;
    calls.clear();
    if (!notified && ui?.notify) {
      notified = true;
      try { ui.notify('Agent Observer logging disabled: storage failed or its bounded queue filled.', 'warning'); } catch {}
    }
  }
  const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : undefined;
  function usage(value) {
    const metadata = {};
    for (const [key, candidate] of [['inputTokens', value?.input], ['outputTokens', value?.output], ['cost', value?.cost?.total]]) {
      const valid = nonnegative(candidate);
      if (valid !== undefined && (key === 'cost' || Number.isInteger(valid))) metadata[key] = valid;
    }
    return metadata;
  }
  function captureContext(ctx) { if (ctx?.hasUI && ctx.ui) ui = ctx.ui; }
  function emit(event, metadata = {}) {
    if (disabled){droppedEvents++;return;}
    if (queue.length >= 100) { droppedEvents++;disable('queue-overflow'); return; }
    const occurredAt=new Date().toISOString();
    queue.push({ schemaVersion:2,eventId:randomBytes(16).toString('hex'),producerId,sequence:++sequence,occurredAt,observedAt:occurredAt,timestamp:occurredAt, session, agent, ...(taskId ? { taskId } : {}), event, ...metadata });
    pump();
  }
  function pump() {
    if (pumping || disabled) return;
    pumping = (async () => {
      await ready;
      while (queue.length && !disabled) {
        const batch=queue.splice(0,25);
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(async()=>{if(store.appendBatch)await store.appendBatch(batch);else for(const event of batch)await store.append(event);}),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Observer append timed out')), 2000); timer.unref?.(); }),
          ]);
        } catch { unconfirmedEvents+=batch.length;disable(); }
        finally { clearTimeout(timer); }
      }
    })().catch(disable).finally(() => { pumping = undefined; if (queue.length && !disabled) pump(); });
  }
  globalThis[workerChannel] = {
    enabled: () => !disabled,
    start(name) {
      if (disabled) return undefined;
      const worker = randomBytes(16).toString('hex');
      const scope = { session, parent: agent, agent: worker, ...(taskId ? { taskId } : {}) };
      const workerStarted = performance.now();
      let ended = false;
      emit('agent_start', { ...scope, status: 'running' });
      return {
        end(status = 'ok', counters) {
          if (ended) return;
          ended = true;
          emit('agent_end', { ...scope, status: ['ok', 'error', 'cancelled', 'timeout'].includes(status) ? status : 'error', durationMs: performance.now() - workerStarted, ...usage(counters) });
        },
      };
    },
  };
  const toolName = value => registeredTools.has(value)?value:'other';
  pi.on('session_start', (_event, ctx) => {
    captureContext(ctx);
    if (disabled) { droppedEvents++;disable(); return; }
    session = randomUUID(); calls.clear(); taskId = undefined;
    emit('session_start', { status: 'ok' });
  });
  pi.on('agent_start', (_event, ctx) => {
    captureContext(ctx);
    started = performance.now(); taskId = randomUUID(); tokens = {}; runStatus = 'ok';
    emit('agent_start', { status: 'running' });
  });
  pi.on('tool_call', (event, ctx) => {
    captureContext(ctx);
    if (disabled){droppedEvents++;return;}
    if (calls.size >= 100){calls.delete(calls.keys().next().value);evictedCorrelations++;}
    const requestId=randomBytes(16).toString('hex');
    calls.set(event.toolCallId, {started:performance.now(),requestId});
    emit('tool_start', { requestId,tool: toolName(event.toolName), status: 'running' });
  });
  pi.on('tool_result', (event, ctx) => {
    captureContext(ctx);
    const call = calls.get(event.toolCallId); calls.delete(event.toolCallId);
    emit('tool_end', {
      tool: toolName(event.toolName), status: event.isError ? 'error' : 'ok',
      ...(call ? {requestId:call.requestId,durationMs:performance.now()-call.started}:{}),
    });
  });
  // Pi AssistantMessage.usage exposes input, output and cost.total. Never read content.
  pi.on('message_end', event => {
    if (disabled || event.message?.role !== 'assistant') return;
    for (const [key, value] of Object.entries(usage(event.message.usage))) tokens[key] = (tokens[key] ?? 0) + value;
    if (event.message.stopReason === 'error') runStatus = 'error';
    else if (event.message.stopReason === 'aborted' && runStatus !== 'error') runStatus = 'cancelled';
  });
  pi.on('agent_end', () => {
    emit('agent_end', { status: runStatus, ...(started !== undefined ? { durationMs: performance.now() - started } : {}), ...tokens });
    started = undefined; taskId = undefined; tokens = {};
  });
  pi.on('session_shutdown', async () => {
    emit('session_end', { status: 'ok' });
    let timer;
    try { await Promise.race([pumping, new Promise(resolve => { timer = setTimeout(resolve, 250); })]); }
    finally { clearTimeout(timer); }
  });
  pi.registerTool({
    name: 'agent_usage_review', label: 'Review agent usage',
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    description: 'Review bounded local metadata logs using deterministic checks. Returns findings and limitations without prompts, arguments, outputs, or an external model.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _input, signal) {
      try {
        signal?.throwIfAborted();
        await ready;
        if (!store) throw new Error('Observer is unavailable');
        const { review } = await import('../src/review.mjs');
        async function* checkedEvents() {
          for await (const event of store.events()) { signal?.throwIfAborted(); yield event; }
        }
        const snapshot = store.snapshot ? await store.snapshot() : undefined;
        const report = await review(snapshot?.events ?? checkedEvents(), { guide: options.guide,coverage:snapshot?.coverage });
        signal?.throwIfAborted();
        const result = { metadataOnly: true, ...report, coverage:{...(snapshot?.coverage??{window:'unknown',truncated:null}),loggingEnabled:!disabled,droppedEvents,unconfirmedEvents,disableReason:disableReason??null,queuedEvents:queue.length,inflightCorrelations:calls.size,evictedCorrelations,producerSequence:sequence}, limitations: [...report.limitations,
          'Only opted-in processes are observed; a delegation call does not prove worker execution.',
          'Queued writes may not appear yet. Workers observed by a parent should not also log independent usage counters.',
          'Findings are deterministic observations, not proof of reasoning quality or task correctness.',
        ] };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { metadataOnly: true } };
      } catch {
        return { isError: true, content: [{ type: 'text', text: signal?.aborted ? 'Metadata review cancelled.' : 'Metadata review unavailable. Check local observer status.' }] };
      }
    },
  });
  return {
    get enabled() { return !disabled; },
    ready,
    get health(){return {loggingEnabled:!disabled,droppedEvents,unconfirmedEvents,disableReason:disableReason??null,queuedEvents:queue.length,evictedCorrelations,producerSequence:sequence};},
    async flush() { await ready; if (pumping) await pumping; },
  };
}

export default function observerExtension(pi, options = {}) { return createObserver(pi, options); }
