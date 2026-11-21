import crypto from 'node:crypto';
import {
  decodeImageDataUrl,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_IMAGE_URL_BYTES,
} from '../core/src/image-input.mjs';
import {
  canonicalModel,
  REASONING_EFFORT_LEVELS,
} from '../core/src/openai-contract.mjs';
import {
  plainObject,
  protocolError,
  parseBoundedJson,
} from '../core/src/tool-protocol.mjs';
import { cloakChatBody, cloakResponsesBody } from './cloak.mjs';

const SUPPORTED_CHAT_KEYS = new Set([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'thinking_level',
  'reasoning_effort',
  'stream',
  'stream_options',
  'store',
  'parallel_tool_calls',
  'reasoning',
  'prompt_cache_key',
  'client_metadata',
  'native_search',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'logprobs',
  'top_logprobs',
  'response_format',
  'user',
  'metadata',
  'stop',
  'n',
  'service_tier',
  'logit_bias',
  'verbosity',
  'modalities',
]);

const SUPPORTED_RESPONSES_KEYS = new Set([
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'thinking_level',
  'reasoning_effort',
  'stream',
  'store',
  'parallel_tool_calls',
  'reasoning',
  'include',
  'prompt_cache_key',
  'client_metadata',
  'native_search',
  'temperature',
  'top_p',
  'max_output_tokens',
  'text',
  'user',
  'metadata',
  'service_tier',
  'truncation',
]);

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value.isWellFormed() ? value : value.toWellFormed();
}

function sanitizeJsonStrings(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[sanitizeText(k)] = sanitizeJsonStrings(v);
    }
    return out;
  }
  return value;
}

export function createToolCodec() {
  const rawToEncodedName = new Map();
  const encodedToRawName = new Map();
  const rawToEncodedIdQueue = new Map();
  const encodedToRawId = new Map();
  const usedEncodedIds = new Set();
  let idSeq = 0;

  function encodeToolName(rawName) {
    const key = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'tool';
    if (rawToEncodedName.has(key)) return rawToEncodedName.get(key);
    if (/^[A-Za-z0-9_-]{1,64}$/.test(key) && !encodedToRawName.has(key)) {
      rawToEncodedName.set(key, key);
      encodedToRawName.set(key, key);
      return key;
    }
    const base =
      key.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'tool';
    let attempt = 0;
    while (true) {
      const hashInput = attempt === 0 ? key : `${key}\0${attempt}`;
      const hash = crypto
        .createHash('sha256')
        .update(hashInput)
        .digest('hex')
        .slice(0, 8);
      const prefix = base.slice(0, Math.max(1, 64 - 1 - hash.length));
      const candidate = `${prefix}_${hash}`;
      if (!encodedToRawName.has(candidate)) {
        rawToEncodedName.set(key, candidate);
        encodedToRawName.set(candidate, key);
        return candidate;
      }
      attempt++;
    }
  }

  function decodeToolName(encodedName) {
    return encodedToRawName.get(encodedName) ?? encodedName;
  }

  function allocateUniqueCallId(rawId) {
    const key =
      typeof rawId === 'string' && rawId.length > 0 ? rawId : `call_${++idSeq}`;
    let candidate;
    if (/^[A-Za-z0-9_-]{1,256}$/.test(key) && !usedEncodedIds.has(key)) {
      candidate = key;
    } else {
      const sanitized = key.replace(/[^A-Za-z0-9_-]/g, '_') || 'call';
      const suffix = `_${++idSeq}`;
      candidate = `${sanitized.slice(0, Math.max(1, 256 - suffix.length))}${suffix}`;
      while (usedEncodedIds.has(candidate)) {
        const extraSuffix = `_${++idSeq}`;
        candidate = `${sanitized.slice(0, Math.max(1, 256 - extraSuffix.length))}${extraSuffix}`;
      }
    }
    usedEncodedIds.add(candidate);
    encodedToRawId.set(candidate, key);
    return candidate;
  }

  function encodeAssistantToolCallId(rawId) {
    const key =
      typeof rawId === 'string' && rawId.length > 0 ? rawId : `call_${++idSeq}`;
    const candidate = allocateUniqueCallId(key);
    let queue = rawToEncodedIdQueue.get(key);
    if (!queue) {
      queue = [];
      rawToEncodedIdQueue.set(key, queue);
    }
    queue.push(candidate);
    return candidate;
  }

  function encodeToolResultCallId(rawId) {
    const key = typeof rawId === 'string' && rawId.length > 0 ? rawId : '';
    const queue = key ? rawToEncodedIdQueue.get(key) : undefined;
    if (queue && queue.length > 0) {
      return queue.shift();
    }
    return allocateUniqueCallId(key || `call_${++idSeq}`);
  }

  function releaseEncodedToolCallId(encodedId) {
    const rawId = encodedToRawId.get(encodedId);
    if (!rawId) return;
    const queue = rawToEncodedIdQueue.get(rawId);
    if (!queue) return;
    const idx = queue.indexOf(encodedId);
    if (idx >= 0) queue.splice(idx, 1);
  }

  function decodeToolCallId(encodedId) {
    return encodedToRawId.get(encodedId) ?? encodedId;
  }

  return {
    encodeToolName,
    decodeToolName,
    encodeAssistantToolCallId,
    encodeToolResultCallId,
    releaseEncodedToolCallId,
    decodeToolCallId,
  };
}

function normalizeModelName(rawModel) {
  let model =
    typeof rawModel === 'string' && rawModel.trim()
      ? rawModel.trim()
      : 'gemini-neon';
  if (model.startsWith('gemini-app/')) {
    model = model.slice('gemini-app/'.length);
  }
  return canonicalModel(model);
}

function normalizeEffort(effort) {
  if (typeof effort !== 'string') return undefined;
  const lowered = effort.trim().toLowerCase();
  if (lowered === 'max') return 'xhigh';
  return Object.hasOwn(REASONING_EFFORT_LEVELS, lowered) ? lowered : undefined;
}

function normalizeThinkingFields(rawBody, model) {
  if (model === 'gemini-auto') {
    return {};
  }
  const out = {};
  if (
    Number.isSafeInteger(rawBody.thinking_level) &&
    rawBody.thinking_level >= 0 &&
    rawBody.thinking_level <= 2
  ) {
    out.thinking_level = rawBody.thinking_level;
  }

  const topEffort = normalizeEffort(rawBody.reasoning_effort);
  const nestedEffort = normalizeEffort(rawBody.reasoning?.effort);
  const resolvedEffort = topEffort ?? nestedEffort;

  if (resolvedEffort !== undefined && out.thinking_level === undefined) {
    out.reasoning_effort = resolvedEffort;
  }

  if (
    rawBody.reasoning &&
    typeof rawBody.reasoning === 'object' &&
    !Array.isArray(rawBody.reasoning)
  ) {
    const reasoning = {};
    if (rawBody.reasoning.summary === 'none') {
      reasoning.summary = 'none';
    }
    if (resolvedEffort !== undefined && out.thinking_level === undefined) {
      reasoning.effort = resolvedEffort;
    }
    if (Object.keys(reasoning).length > 0) {
      out.reasoning = reasoning;
    }
  }

  if (
    out.thinking_level === undefined &&
    out.reasoning_effort === undefined &&
    rawBody.thinking &&
    typeof rawBody.thinking === 'object'
  ) {
    if (rawBody.thinking.type === 'disabled') {
      out.thinking_level = 0;
    } else if (rawBody.thinking.type === 'enabled') {
      const budget = Number(rawBody.thinking.budget_tokens);
      if (Number.isFinite(budget) && budget > 0) {
        out.reasoning_effort =
          budget <= 4096 ? 'low' : budget <= 12000 ? 'medium' : 'high';
      } else {
        out.reasoning_effort = 'high';
      }
    }
  }

  return out;
}

function normalizeImageDataOrUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { error: '[Image omitted: empty image URL]' };
  }
  let url = rawUrl.trim();
  if (/^https?:/i.test(url)) {
    return { url };
  }
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(url);
  if (!match) {
    return { error: '[Image omitted: unsupported image URL]' };
  }
  let mime = match[1].trim().toLowerCase();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
    return { error: `[Image omitted: unsupported format ${mime}]` };
  }
  const compactBase64 = match[2].replace(/\s+/g, '');
  const normalizedUrl = `data:${mime};base64,${compactBase64}`;
  if (Buffer.byteLength(normalizedUrl) > MAX_IMAGE_URL_BYTES) {
    return { error: `[Image omitted: ${mime} exceeded 2MB limit]` };
  }
  try {
    const decoded = decodeImageDataUrl(normalizedUrl);
    return { url: decoded.url, byteLength: decoded.data.length };
  } catch (err) {
    return {
      error: `[Image omitted: invalid ${mime} (${err?.code || 'INVALID_IMAGE'})]`,
    };
  }
}

function extractTextParts(content) {
  if (typeof content === 'string') return sanitizeText(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(sanitizeText(part));
    } else if (part && typeof part === 'object') {
      if (typeof part.text === 'string') {
        parts.push(sanitizeText(part.text));
      } else if (part.type === 'input_text' && typeof part.text === 'string') {
        parts.push(sanitizeText(part.text));
      }
    }
  }
  return parts.join('');
}

function normalizeToolArguments(rawArgs) {
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed) return '{}';
    try {
      const parsed = parseBoundedJson(trimmed, { status: 400 });
      if (plainObject(parsed)) {
        return sanitizeText(JSON.stringify(sanitizeJsonStrings(parsed)));
      }
    } catch {}
    return '{}';
  }
  if (plainObject(rawArgs)) {
    try {
      return sanitizeText(JSON.stringify(sanitizeJsonStrings(rawArgs)));
    } catch {
      return '{}';
    }
  }
  return '{}';
}

function normalizeToolsList(rawTools, codec) {
  if (!Array.isArray(rawTools)) return [];
  const tools = [];
  for (const raw of rawTools) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const fn = raw.type === 'function' ? raw.function : raw.function || (typeof raw.name === 'string' ? raw : null);
    if (!fn || typeof fn !== 'object' || typeof fn.name !== 'string' || !fn.name) {
      continue;
    }
    const encodedName = codec.encodeToolName(fn.name);
    const parameters =
      fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)
        ? sanitizeJsonStrings(fn.parameters)
        : fn.input_schema && typeof fn.input_schema === 'object' && !Array.isArray(fn.input_schema)
          ? sanitizeJsonStrings(fn.input_schema)
          : { type: 'object', properties: {} };
    const cleanFn = {
      name: encodedName,
      ...(typeof fn.description === 'string'
        ? { description: sanitizeText(fn.description) }
        : {}),
      parameters,
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
    };
    tools.push({ type: 'function', function: cleanFn });
  }
  return tools;
}

function normalizeToolChoice(rawChoice, tools, codec) {
  if (rawChoice === undefined || rawChoice === null) return undefined;
  if (rawChoice === 'none') return 'none';
  if (!tools.length) return undefined;
  if (rawChoice === 'auto' || rawChoice === 'required') return rawChoice;
  if (plainObject(rawChoice)) {
    const name = rawChoice.function?.name ?? rawChoice.name;
    if (typeof name === 'string' && name) {
      const encoded = codec.encodeToolName(name);
      if (tools.some((t) => t.function.name === encoded)) {
        return { type: 'function', function: { name: encoded } };
      }
    }
  }
  return undefined;
}

export function sanitizeChatRequest(rawBody, { cloakSheet = true } = {}) {
  if (!plainObject(rawBody)) {
    throw protocolError('INVALID_REQUEST', 400);
  }
  const codec = createToolCodec();
  const model = normalizeModelName(rawBody.model);
  const stream = rawBody.stream === true;
  const includeUsage = stream && rawBody.stream_options?.include_usage === true;

  const body = {
    model,
    stream,
    ...normalizeThinkingFields(rawBody, model),
  };

  if (stream && rawBody.stream_options !== undefined && rawBody.stream_options !== null) {
    body.stream_options = { include_usage: includeUsage };
  }

  for (const key of SUPPORTED_CHAT_KEYS) {
    if (
      [
        'model',
        'messages',
        'tools',
        'tool_choice',
        'thinking_level',
        'reasoning_effort',
        'reasoning',
        'stream',
        'stream_options',
      ].includes(key)
    ) {
      continue;
    }
    const val = rawBody[key];
    if (val === undefined || val === null) continue;
    if (key === 'store' && val !== false) continue;
    if (key === 'n' && val !== 1) continue;
    if (key === 'modalities' && (!Array.isArray(val) || val.length !== 1 || val[0] !== 'text')) {
      continue;
    }
    body[key] = val;
  }

  const tools = normalizeToolsList(rawBody.tools, codec);
  if (tools.length > 0) {
    body.tools = tools;
  }
  const toolChoice = normalizeToolChoice(rawBody.tool_choice, tools, codec);
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice;
  }

  const rawMessages = Array.isArray(rawBody.messages) ? rawBody.messages : [];
  const messages = [];
  const pendingToolCallIds = [];
  const pendingToolCallSet = new Set();
  const pendingTurnImages = [];

  let imageCount = 0;
  let imageBytes = 0;

  const takeImage = (rawUrl) => {
    const res = normalizeImageDataOrUrl(rawUrl);
    if (res.error) return { type: 'text', text: res.error };
    if (imageCount >= MAX_IMAGES) {
      return { type: 'text', text: '[Image omitted: exceeded 4-image limit]' };
    }
    const size = res.byteLength ?? 0;
    if (size > MAX_IMAGE_BYTES || imageBytes + size > MAX_TOTAL_IMAGE_BYTES) {
      return { type: 'text', text: '[Image omitted: exceeded 2MB total image budget]' };
    }
    imageCount++;
    imageBytes += size;
    return { type: 'image_url', image_url: { url: res.url, detail: 'auto' } };
  };

  const flushPendingToolBatch = () => {
    if (pendingToolCallIds.length > 0) {
      for (const missingId of pendingToolCallIds) {
        codec.releaseEncodedToolCallId(missingId);
        messages.push({
          role: 'tool',
          tool_call_id: missingId,
          content: '[Tool execution aborted]',
        });
      }
      pendingToolCallIds.length = 0;
      pendingToolCallSet.clear();
    }
    if (pendingTurnImages.length > 0) {
      messages.push({
        role: 'user',
        content: pendingTurnImages.splice(0, pendingTurnImages.length),
      });
    }
  };

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;

    if (role === 'system' || role === 'developer') {
      flushPendingToolBatch();
      const text = extractTextParts(msg.content);
      if (text.length > 0) {
        messages.push({ role, content: text });
      }
      continue;
    }

    if (role === 'user') {
      flushPendingToolBatch();
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: sanitizeText(msg.content) });
        continue;
      }
      if (!Array.isArray(msg.content)) {
        messages.push({ role: 'user', content: '' });
        continue;
      }
      const parts = [];
      let hasImage = false;
      for (const part of msg.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push({ type: 'text', text: sanitizeText(part.text) });
        } else if (part.type === 'input_text' && typeof part.text === 'string') {
          parts.push({ type: 'text', text: sanitizeText(part.text) });
        } else if (part.type === 'image_url') {
          const url =
            typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          const taken = takeImage(url);
          if (taken.type === 'image_url') hasImage = true;
          parts.push(taken);
        }
      }
      if (!parts.length) {
        messages.push({ role: 'user', content: '' });
      } else if (!hasImage) {
        messages.push({ role: 'user', content: parts.map((p) => p.text).join('') });
      } else {
        messages.push({ role: 'user', content: parts });
      }
      continue;
    }

    if (role === 'assistant') {
      flushPendingToolBatch();
      const text = extractTextParts(msg.content);
      const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const encodedCalls = [];
      for (const call of rawCalls) {
        if (!call || typeof call !== 'object') continue;
        const fn = call.function;
        if (!fn || typeof fn !== 'object' || typeof fn.name !== 'string' || !fn.name) {
          continue;
        }
        const encodedId = codec.encodeAssistantToolCallId(call.id);
        const encodedName = codec.encodeToolName(fn.name);
        encodedCalls.push({
          id: encodedId,
          type: 'function',
          function: {
            name: encodedName,
            arguments: normalizeToolArguments(fn.arguments),
          },
        });
      }
      if (encodedCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          tool_calls: encodedCalls,
        });
        for (const c of encodedCalls) {
          pendingToolCallIds.push(c.id);
          pendingToolCallSet.add(c.id);
        }
      } else {
        messages.push({ role: 'assistant', content: text });
      }
      continue;
    }

    if (role === 'tool') {
      const encodedId = codec.encodeToolResultCallId(msg.tool_call_id);
      if (!pendingToolCallSet.has(encodedId)) {
        flushPendingToolBatch();
        const synthName = codec.encodeToolName(msg.name || 'tool');
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: encodedId,
              type: 'function',
              function: { name: synthName, arguments: '{}' },
            },
          ],
        });
      } else {
        pendingToolCallSet.delete(encodedId);
        const idx = pendingToolCallIds.indexOf(encodedId);
        if (idx >= 0) pendingToolCallIds.splice(idx, 1);
      }

      let toolText = '';
      if (typeof msg.content === 'string') {
        toolText = sanitizeText(msg.content);
      } else if (Array.isArray(msg.content)) {
        const textChunks = [];
        for (const part of msg.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text' && typeof part.text === 'string') {
            textChunks.push(sanitizeText(part.text));
          } else if (part.type === 'image_url') {
            const url =
              typeof part.image_url === 'string'
                ? part.image_url
                : part.image_url?.url;
            const taken = takeImage(url);
            if (taken.type === 'image_url') {
              pendingTurnImages.push(taken);
            } else {
              textChunks.push(taken.text);
            }
          }
        }
        toolText = textChunks.join('\n');
      }
      messages.push({
        role: 'tool',
        tool_call_id: encodedId,
        content: toolText,
      });
    }
  }

  flushPendingToolBatch();

  body.messages = messages;
  if (cloakSheet) {
    cloakChatBody(body);
  }

  return {
    body,
    codec,
    stream,
    includeUsage,
    route: 'chat',
  };
}

export function sanitizeResponsesRequest(rawBody, { cloakSheet = true } = {}) {
  if (!plainObject(rawBody)) {
    throw protocolError('INVALID_REQUEST', 400);
  }
  const model = normalizeModelName(rawBody.model);
  const stream = rawBody.stream === true;
  const body = {
    model,
    stream,
    ...normalizeThinkingFields(rawBody, model),
  };

  for (const key of SUPPORTED_RESPONSES_KEYS) {
    if (
      [
        'model',
        'thinking_level',
        'reasoning_effort',
        'reasoning',
        'stream',
      ].includes(key)
    ) {
      continue;
    }
    const val = rawBody[key];
    if (val === undefined || val === null) continue;
    if (key === 'store' && val !== false) continue;
    body[key] = structuredClone(val);
  }

  if (cloakSheet) {
    cloakResponsesBody(body);
  }

  return {
    body,
    codec: createToolCodec(),
    stream,
    includeUsage: false,
    route: 'responses',
  };
}
