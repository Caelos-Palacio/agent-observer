import test from 'node:test';
import assert from 'node:assert/strict';
import { createObserver, observeWorkerStart } from '../integrations/pi-observer.ts';

function host() {
  const hooks = new Map(); const tools = new Map();
  return { hooks, tools, on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.set(tool.name, tool), fire: (name, event = {}, ctx = {}) => hooks.get(name)?.(event, ctx) };
}

test('disabled observer registers no hooks or tools', async () => {
  const pi = host(); const observer = createObserver(pi, { env: {} });
  assert.equal(observer.enabled, false); assert.equal(pi.hooks.size, 0); assert.equal(pi.tools.size, 0);
});

test('only metadata is captured with opaque identities and paired call IDs', async () => {
  const pi = host(); const events = [];
  const observer = createObserver(pi, { env: { AGENT_OBSERVER_ENABLED: '1', PI_LOCAL_SUBAGENT_DEPTH: '2' }, store: { append: async event => events.push(event) } });
  pi.fire('session_start', { previousSessionFile: '/secret/session' });
  pi.fire('agent_start');
  const event = { toolCallId: '/secret/call', toolName: 'subagent' };
  Object.defineProperty(event, 'input', { get() { throw new Error('Arguments were accessed'); } });
  pi.fire('tool_call', event);
  const result = { ...event, isError: false, usage: { input: 3, output: 2 } };
  Object.defineProperty(result, 'content', { get() { throw new Error('Tool content was accessed'); } });
  pi.fire('tool_result', result);
  const message = { role: 'assistant', stopReason: 'stop', usage: { input: 100, output: 40, cost: { total: 0.01 } } };
  Object.defineProperty(message, 'content', { get() { throw new Error('Message content was accessed'); } });
  pi.fire('message_end', { message });
  pi.fire('agent_end', { messages: [{ content: 'secret-output' }] });
  pi.fire('session_shutdown');
  await observer.flush();
  assert.deepEqual(events.map(e => e.event), ['session_start', 'agent_start', 'tool_start', 'tool_end', 'agent_end', 'session_end']);
  assert.equal(events[4].inputTokens, 100); assert.equal(events[4].outputTokens, 40); assert.equal(events[4].cost, 0.01);
  assert.equal(events[3].inputTokens, undefined); assert.ok(events[3].durationMs >= 0);
  assert.ok(events.every(e=>e.agent===events[0].agent));assert.match(events[0].agent,/^[a-f0-9]{32}$/);assert.equal(events[2].requestId,events[3].requestId);assert.deepEqual(events.map(e=>e.sequence),[1,2,3,4,5,6]);
  assert.doesNotMatch(JSON.stringify(events), /secret|content|arguments|\/secret/);
  const allowed = new Set(['timestamp', 'session', 'agent', 'taskId', 'event', 'tool', 'status', 'durationMs', 'inputTokens', 'outputTokens', 'cost','schemaVersion','eventId','producerId','sequence','occurredAt','observedAt','requestId']);
  assert.ok(events.every(event => Object.keys(event).every(key => allowed.has(key))));
});

test('disk failures disable logging and notify once without changing results', async () => {
  const pi = host(); let notices = 0;
  const observer = createObserver(pi, { enabled: true, env: {}, store: { append: async () => { throw new Error('secret disk path'); } } });
  const ctx = { hasUI: true, ui: { notify: text => { assert.doesNotMatch(text, /secret/); notices++; } } };
  pi.fire('session_start', {}, ctx);
  await observer.flush();
  assert.equal(observer.enabled, false);
  assert.equal(pi.fire('tool_result', { toolName: 'read', toolCallId: 'x', isError: false }, ctx), undefined);
  pi.fire('session_start', {}, ctx);
  assert.equal(notices, 1);
});

test('queue overflow disables logging instead of retaining unbounded events', async () => {
  const pi = host(); const observer = createObserver(pi, { enabled: true, env: {}, store: { append: async () => {} } });
  for (let i = 0; i < 105; i++) pi.fire('tool_call', { toolCallId: String(i), toolName: 'read' });
  await observer.flush(); assert.equal(observer.enabled, false);
});

test('assistant errors and aborts are reflected in run metadata', async () => {
  const pi = host(); const events = [];
  const observer = createObserver(pi, { enabled: true, env: {}, store: { append: async event => events.push(event) } });
  pi.fire('agent_start'); pi.fire('message_end', { message: { role: 'assistant', stopReason: 'aborted' } }); pi.fire('agent_end');
  await observer.flush(); assert.equal(events.at(-1).status, 'cancelled'); assert.equal(events.at(-1).inputTokens, undefined);
});

test('explicit environment disable overrides host opt-in', () => {
  const pi = host();
  assert.equal(createObserver(pi, { enabled: true, env: { AGENT_OBSERVER_ENABLED: '0' } }).enabled, false);
  assert.equal(pi.hooks.size, 0);
});

test('review tool reads only bounded metadata and returns deterministic findings', async () => {
  const pi = host();
  const observer = createObserver(pi, { enabled: true, env: {}, store: {
    append: async () => {},
    async *events() { yield { event: 'tool_end', tool: 'read', status: 'error', durationMs: 20, timestamp: new Date().toISOString() }; },
  } });
  await observer.ready;
  const result = await pi.tools.get('agent_usage_review').execute('id', {});
  assert.equal(result.isError, undefined);
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.metadataOnly, true);
  assert.ok(report.limitations.some(text => text.includes('reasoning quality')));
  assert.equal(pi.tools.size, 1);
});

test('parent observes unique worker lifecycle and records counters once', async () => {
  const pi = host(); const events = [];
  const observer = createObserver(pi, { enabled: true, env: {}, store: { append: async event => events.push(event) } });
  pi.fire('session_start'); pi.fire('agent_start');
  const first = observeWorkerStart('reviewer');
  const second = observeWorkerStart('reviewer');
  first.end('ok', { input: 20, output: 5, cost: { total: 0.02 } });
  first.end('error'); second.end('timeout');
  pi.fire('agent_end'); await observer.flush();
  const workers = events.filter(event => event.parent);
  assert.equal(workers.length, 4);
  assert.notEqual(workers[0].agent, workers[1].agent);
  assert.equal(workers[0].session, workers[1].session);
  assert.equal(workers[0].parent,events[0].agent);
  assert.doesNotMatch(JSON.stringify(workers), /reviewer/);
  assert.equal(workers[2].inputTokens, 20);
  assert.equal(workers[3].inputTokens, undefined);
  assert.equal(workers[3].status, 'timeout');
});

test('review includes recent snapshot coverage and host guide', async () => {
  const pi = host();
  const observer = createObserver(pi, { enabled: true, env: {}, guide: { version: 1, thresholds: { slowToolMs: 1 } }, store: {
    append: async () => {},
    async snapshot() { return { events: [{ event: 'tool_end', tool: 'read', status: 'ok', durationMs: 20 }], coverage: { window: 'latest-retained', truncated: true, returnedEvents: 1 } }; },
  } });
  await observer.ready;
  const report = JSON.parse((await pi.tools.get('agent_usage_review').execute('id', {})).content[0].text);
  assert.equal(report.coverage.truncated, true);
  assert.equal(report.metrics.slowToolCalls, 1);
});
test('logging gaps remain visible to review after queue overload',async()=>{
  const pi=host(),observer=createObserver(pi,{enabled:true,env:{},store:{append:async()=>{},snapshot:async()=>({events:[],coverage:{window:'latest-retained'}})}});
  for(let i=0;i<105;i++)pi.fire('tool_call',{toolCallId:String(i),toolName:'PRIVATE_SENTINEL'});
  await observer.flush();
  assert.equal(observer.health.loggingEnabled,false);assert.ok(observer.health.droppedEvents>=100);
  const result=await pi.tools.get('agent_usage_review').execute('id',{}),report=JSON.parse(result.content[0].text);
  assert.equal(report.coverage.loggingEnabled,false);assert.ok(report.coverage.droppedEvents>=100);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_SENTINEL/);
});
