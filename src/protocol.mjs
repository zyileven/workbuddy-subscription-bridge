import { randomUUID } from 'node:crypto';
import { BridgeError, sseEvents } from './common.mjs';
import { upstreamModelId } from './models.mjs';

const fail = (message, param) => { throw new BridgeError(message, 400, 'unsupported_request', { param }); };
const nameOK = n => typeof n === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(n);
const ignoredFields = new Set(['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens',
  'presence_penalty', 'frequency_penalty', 'logit_bias', 'seed', 'user', 'metadata', 'store', 'service_tier', 'prompt_cache_key', 'reasoning_content']);
const supportedFields = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'n', 'reasoning_effort', 'parallel_tool_calls']);

function content(value, role) {
  if (typeof value === 'string') return [{ type: 'input_text', text: value }];
  if (value == null && role === 'assistant') return [];
  if (!Array.isArray(value)) fail('Message content must be text or a supported content-part array.', 'messages');
  return value.map(p => {
    if (p?.type === 'text' && typeof p.text === 'string') return { type: 'input_text', text: p.text };
    if (p?.type === 'image_url' && role === 'user') {
      const url = p.image_url?.url;
      if (typeof url !== 'string' || !/^(https:\/\/|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(url)) fail('Images must use HTTPS or an inline image data URL.', 'messages');
      const detail = p.image_url.detail ?? 'auto';
      if (!['auto', 'low', 'high', 'original'].includes(detail)) fail('Unsupported image detail.', 'messages');
      return { type: 'input_image', image_url: url, detail };
    }
    fail(`Unsupported message content type: ${p?.type ?? 'unknown'}.`, 'messages');
  });
}

export function toResponses(request) {
  if (!request || Array.isArray(request) || typeof request !== 'object') fail('Expected a JSON object.');
  if (typeof request.model !== 'string' || !request.model.trim()) fail('Choose a model slug returned by /v1/models.', 'model');
  if (!Array.isArray(request.messages) || !request.messages.length) fail('messages must be a non-empty array.', 'messages');
  if (request.n !== undefined && request.n !== 1) fail('Only n=1 is supported.', 'n');
  if (request.stream !== undefined && typeof request.stream !== 'boolean') fail('stream must be a boolean.', 'stream');
  if (request.parallel_tool_calls !== undefined && typeof request.parallel_tool_calls !== 'boolean') fail('parallel_tool_calls must be a boolean.', 'parallel_tool_calls');
  if (request.stream_options && (typeof request.stream_options !== 'object' || Object.keys(request.stream_options).some(k => k !== 'include_usage') ||
      (request.stream_options.include_usage !== undefined && typeof request.stream_options.include_usage !== 'boolean'))) fail('Only stream_options.include_usage is supported.', 'stream_options');
  const ignored = [];
  for (const key of Object.keys(request)) {
    if (ignoredFields.has(key)) ignored.push(key);
    else if (!supportedFields.has(key)) fail(`Unsupported request parameter: ${key}.`, key);
  }
  const input = [], calls = new Set(), results = new Set();
  for (const m of request.messages) {
    if (!m || typeof m !== 'object') fail('Invalid message.', 'messages');
    if (m.role === 'tool') {
      if (!m.tool_call_id || !calls.has(m.tool_call_id) || results.has(m.tool_call_id)) fail('Tool output must reference one preceding unmatched tool_call_id.', 'messages');
      results.add(m.tool_call_id);
      const output = content(m.content, 'tool').map(p => p.text).join('\n');
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output }); continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(m.role)) fail('Unsupported message role.', 'messages');
    const parts = content(m.content, m.role);
    if (m.role === 'assistant') {
      const text = parts.map(p => p.text).join('');
      if (text) input.push({ role: 'assistant', content: text });
      if (m.tool_calls !== undefined && !Array.isArray(m.tool_calls)) fail('tool_calls must be an array.', 'messages');
      for (const call of m.tool_calls ?? []) {
        if (call.type !== 'function' || !nameOK(call.function?.name) || typeof call.id !== 'string' || !call.id || calls.has(call.id) || typeof call.function.arguments !== 'string') fail('Invalid function tool call in history.', 'messages');
        try { JSON.parse(call.function.arguments); } catch { fail('Historical function arguments must be JSON.', 'messages'); }
        calls.add(call.id);
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name,
          namespace: 'workbuddy', arguments: call.function.arguments });
      }
    } else {
      if (m.tool_calls) fail('Only assistant messages can contain tool_calls.', 'messages');
      input.push({ role: m.role === 'system' ? 'developer' : m.role, content: parts });
    }
  }
  if (calls.size !== results.size) fail('Each historical tool call needs its tool result before the next request.', 'messages');
  const body = { model: upstreamModelId(request.model), input, store: false, stream: true };
  const names = new Set();
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) fail('tools must be an array.', 'tools');
    const functions = request.tools.map(t => {
      const f = t?.function;
      if (t?.type !== 'function' || !nameOK(f?.name) || names.has(f.name)) fail('Only uniquely named function tools are supported.', 'tools');
      if (f.parameters !== undefined && (!f.parameters || typeof f.parameters !== 'object' || Array.isArray(f.parameters))) fail('Function parameters must be a JSON schema object.', 'tools');
      names.add(f.name);
      return { type: 'function', name: f.name, description: f.description ?? '',
        parameters: f.parameters ?? { type: 'object', properties: {} }, strict: f.strict ?? false };
    });
    if (functions.length) body.tools = [{ type: 'namespace', name: 'workbuddy', description: 'Tools executed locally by WorkBuddy.', tools: functions }];
  }
  if (request.tool_choice !== undefined) {
    if (!['auto', 'none', 'required'].includes(request.tool_choice)) fail('This prototype supports tool_choice auto/none/required; named forced-tool selection is not supported.', 'tool_choice');
    if (request.tool_choice === 'required' && !names.size) fail('tool_choice required needs tools.', 'tool_choice');
    body.tool_choice = request.tool_choice;
  }
  if (request.parallel_tool_calls !== undefined) body.parallel_tool_calls = request.parallel_tool_calls;
  if (request.reasoning_effort !== undefined) {
    if (typeof request.reasoning_effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(request.reasoning_effort)) fail('reasoning_effort must be an effort name from the selected model catalog.', 'reasoning_effort');
    body.reasoning = { effort: request.reasoning_effort };
  }
  return { body, ignored, names };
}

export function chatUsage(usage) {
  if (!usage) return undefined;
  return { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    ...(usage.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}),
    ...(usage.output_tokens_details ? { completion_tokens_details: usage.output_tokens_details } : {}) };
}

export async function convertResponse(response, model, names, emit) {
  const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
  let text = '', complete = false, usage, started = false;
  const calls = new Map(), completedOutput = new Map();
  const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason }] });
  const send = async delta => {
    if (!emit) return;
    if (!started) { await emit(chunk({ role: 'assistant', content: '' })); started = true; }
    await emit(chunk(delta));
  };
  const ensureCall = async item => {
    const key = item.call_id;
    let name = item.name;
    if (typeof name === 'string' && name.startsWith('workbuddy.')) name = name.slice(10);
    if (!key || !nameOK(name) || !names.has(name) || (item.namespace && item.namespace !== 'workbuddy')) throw new BridgeError('Upstream returned an unknown function tool.', 502, 'invalid_tool_call');
    if (!calls.has(key)) {
      const call = { index: calls.size, id: key, itemId: item.id, type: 'function', function: { name, arguments: '' } };
      calls.set(key, call);
      await send({ tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name, arguments: '' } }] });
    }
    return calls.get(key);
  };
  const appendArguments = async (call, delta) => {
    if (!delta) return;
    call.function.arguments += delta;
    await send({ tool_calls: [{ index: call.index, function: { arguments: delta } }] });
  };
  const reconcileArguments = async (call, args) => {
    if (typeof args !== 'string' || !args.startsWith(call.function.arguments)) throw new BridgeError('Inconsistent upstream tool argument stream.', 502, 'invalid_tool_arguments');
    await appendArguments(call, args.slice(call.function.arguments.length));
  };
  for await (const event of sseEvents(response.body)) {
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      const delta = event.delta;
      if (typeof delta !== 'string') throw new BridgeError('Invalid text stream.', 502, 'invalid_upstream_event');
      text += delta; await send({ content: delta });
    } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const call = await ensureCall(event.item); await reconcileArguments(call, event.item.arguments ?? '');
    } else if (event.type === 'response.function_call_arguments.delta' || event.type === 'response.function_call_arguments.done') {
      const call = [...calls.values()].find(c => c.itemId === event.item_id);
      if (!call) throw new BridgeError('Arguments arrived without a matching function call.', 502, 'invalid_tool_call');
      if (event.type.endsWith('.delta')) await appendArguments(call, event.delta);
      else await reconcileArguments(call, event.arguments);
    } else if (event.type === 'response.output_item.done') {
      if (event.item?.type === 'function_call') await reconcileArguments(await ensureCall(event.item), event.item.arguments);
      if (['message', 'function_call'].includes(event.item?.type)) {
        completedOutput.set(event.item.id ?? event.output_index, { index: event.output_index ?? completedOutput.size, item: event.item });
      }
    } else if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      const e = event.response?.error ?? event.error ?? event;
      const code = typeof e.code === 'string' ? e.code : event.type === 'response.incomplete' ? 'response_incomplete' : 'upstream_stream_error';
      throw new BridgeError(`OpenAI stream did not complete (${code}).`, code.includes('limit') ? 429 : 502, code, { param: e.param });
    } else if (event.type === 'response.completed') {
      const final = event.response;
      if (final?.status !== 'completed' || !Array.isArray(final.output)) throw new BridgeError('Invalid completion event.', 502, 'invalid_completion');
      // Some store:false streams leave the terminal output array empty after
      // delivering the completed items. Reconcile against those snapshots.
      const output = final.output.length ? final.output : [...completedOutput.values()].sort((a, b) => a.index - b.index).map(value => value.item);
      const finalText = output.filter(o => o.type === 'message').flatMap(o => o.content ?? [])
        .map(p => p.type === 'output_text' ? p.text : p.type === 'refusal' ? p.refusal : '').join('');
      if (!finalText.startsWith(text)) throw new BridgeError('Final text differs from the streamed text.', 502, 'inconsistent_stream');
      const remaining = finalText.slice(text.length); if (remaining) { text += remaining; await send({ content: remaining }); }
      for (const item of output.filter(o => o.type === 'function_call')) await reconcileArguments(await ensureCall(item), item.arguments);
      for (const call of calls.values()) { try { JSON.parse(call.function.arguments); } catch { throw new BridgeError('Completed function arguments are not JSON.', 502, 'invalid_tool_arguments'); } }
      usage = chatUsage(final.usage); complete = true; break;
    }
    // Reasoning events and other non-output progress events are not exposed.
  }
  if (!complete) throw new BridgeError('OpenAI stream ended before response.completed.', 502, 'truncated_stream');
  const finish = calls.size ? 'tool_calls' : 'stop';
  const message = { role: 'assistant', content: text || (calls.size ? null : '') };
  if (calls.size) message.tool_calls = [...calls.values()].map(({ id: callId, type, function: fn }) => ({ id: callId, type, function: fn }));
  if (emit) {
    if (!started) await emit(chunk({ role: 'assistant', content: '' }));
    await emit(chunk({}, finish));
  }
  return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) };
}
