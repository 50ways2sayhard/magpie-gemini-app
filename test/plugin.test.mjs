import { describe, expect, test } from 'bun:test';
import zlib from 'node:zlib';
import * as pluginModule from '../index.mjs';
import {
  lengthDelimited as m,
  varintField as v,
} from '../core/native-wire/protobuf.mjs';
import { normalizeChatRequest } from '../core/src/openai-contract.mjs';

const { default: pluginDefault, _internal } = pluginModule;

function makeMinimalPngBase64() {
  const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    let c = value;
    for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const VALID_PNG_BASE64 = makeMinimalPngBase64();

function makeMinimalJpegBase64() {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, // SOF0 1x1
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
    0x00, 0x00, 0x00, // scan data
    0xff, 0xd9, // EOI
  ]).toString('base64');
}

const VALID_JPEG_BASE64 = makeMinimalJpegBase64();

function buildNativeFrame(
  text,
  {
    mode = 1,
    complete = true,
    thinking = 2,
    responseId = 'resp_test_1',
    attribution = mode === 1
      ? 'Used 4 Hydrogen High model'
      : mode === 3
        ? 'Used 4 Neon High model'
        : undefined,
  } = {},
) {
  const modelFields = Buffer.concat([
    ...(responseId ? [m(1, Buffer.from(responseId))] : []),
    ...(text !== null && text !== undefined ? [m(2, m(1, Buffer.from(text)))] : []),
  ]);
  return m(
    1003,
    m(
      1,
      Buffer.concat([
        ...(modelFields.length ? [m(1, modelFields)] : []),
        ...(mode !== null ? [v(41, mode)] : []),
        ...(thinking !== null ? [v(42, thinking)] : []),
        v(9, Number(Boolean(complete))),
        ...(attribution ? [m(30, Buffer.from(attribution))] : []),
      ]),
    ),
  );
}

const floatField = (number, value) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value);
  return Buffer.concat([Buffer.from([number * 8 + 5]), b]);
};
const tsField = (seconds, nanos = 0) =>
  Buffer.concat([v(1, seconds), ...(nanos ? [v(2, nanos)] : [])]);

function buildUsagePayload({ tier = 2, rows = [] } = {}) {
  const rowBufs = rows.map((row) =>
    m(
      2,
      Buffer.concat([
        ...(row.ts ? [m(1, tsField(row.ts))] : []),
        ...(row.fraction !== undefined && row.fraction !== null
          ? [floatField(2, row.fraction)]
          : []),
        m(3, Buffer.from(row.label)),
      ]),
    ),
  );
  return Buffer.concat([
    ...(tier !== null ? [v(2, tier)] : []),
    ...(rowBufs.length ? [m(3, Buffer.concat([v(1, 1), ...rowBufs]))] : []),
  ]);
}

describe('Entry export hygiene & hooks', () => {
  test('exports only default { id, server } and _internal object (no bare helper functions)', () => {
    expect(pluginDefault.id).toBe('opencode-gemini-app-auth');
    expect(typeof pluginDefault.server).toBe('function');
    for (const [key, val] of Object.entries(pluginModule)) {
      if (key === 'default') continue;
      expect(typeof val).not.toBe('function');
    }
    expect(typeof _internal).toBe('object');
  });

  test('config and provider.models expose expected models and filter free accounts', async () => {
    let savedAuth = null;
    const client = {
      auth: {
        set: async ({ body }) => {
          savedAuth = body;
          return { data: true };
        },
      },
    };
    const hooks = await pluginDefault.server({ client });
    const cfg = {};
    await hooks.config(cfg);
    expect(cfg.provider['gemini-app'].npm).toBe('@ai-sdk/openai-compatible');
    expect(Object.keys(cfg.provider['gemini-app'].models)).toEqual([
      'gemini-neon',
      'gemini-hydrogen',
      'gemini-flash-lite',
      'gemini-auto',
    ]);

    const unauthModels = await hooks.provider.models(cfg.provider['gemini-app'], {});
    expect(Object.keys(unauthModels)).toHaveLength(4);
    expect(unauthModels['gemini-neon'].api.npm).toBe('@ai-sdk/openai-compatible');
    expect(unauthModels['gemini-neon'].limit.context).toBe(512000);

    const proModels = await hooks.provider.models(cfg.provider['gemini-app'], {
      auth: { type: 'oauth', access: 'tok', subscriptionTier: 'pro' },
    });
    expect(Object.keys(proModels)).toHaveLength(4);

    const freeModels = await hooks.provider.models(cfg.provider['gemini-app'], {
      auth: { type: 'oauth', access: 'tok', subscriptionTier: 'free' },
    });
    expect(Object.keys(freeModels)).toEqual(['gemini-auto']);
    expect(savedAuth).toBeNull();
  });
});

describe('sanitizeChatRequest & cloakChatBody', () => {
  test('strips unknown keys, maps reasoning/thinking, repairs tool history, and passes normalizeChatRequest', () => {
    const raw = {
      model: 'gemini-app/gemini-hydrogen',
      stream: true,
      stream_options: { include_usage: true, unknown_opt: 1 },
      reasoning_effort: 'max',
      extra_body: { foo: 'bar' },
      cache_control: { type: 'ephemeral' },
      top_k: 40,
      store: true,
      tools: [
        {
          type: 'function',
          cache_control: { type: 'ephemeral' },
          function: {
            name: 'mcp:lark.edit_sheet',
            description: 'Edit a sheet and sheets in spreadsheet',
            parameters: {
              type: 'object',
              properties: {
                sheet: { type: 'string', description: 'Target Sheet id' },
              },
              required: ['sheet'],
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'mcp:lark.edit_sheet' } },
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'Use docx/sheet/bitable/slides and stylesheet.' }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Check my Sheet please' },
            { type: 'image_url', image_url: { url: `data:image/jpg;base64,${VALID_JPEG_BASE64}`, detail: 'high' } },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${VALID_PNG_BASE64}`, detail: 'auto' } },
            { type: 'image_url', image_url: { url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=' } },
          ],
        },
        {
          role: 'assistant',
          reasoning_content: 'hidden thought',
          content: '',
          tool_calls: [
            {
              id: 'call.weird:1',
              type: 'function',
              function: { name: 'mcp:lark.edit_sheet', arguments: '{"sheet":"s1"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'orphan.call:2',
          name: 'mcp:lark.edit_sheet',
          content: [{ type: 'text', text: 'orphan output' }],
        },
      ],
    };

    const { body, codec, includeUsage } = _internal.sanitizeChatRequest(raw, {
      cloakSheet: true,
    });
    expect(includeUsage).toBe(true);
    expect(body.model).toBe('gemini-hydrogen');
    expect(body.reasoning_effort).toBe('xhigh');
    expect(body.extra_body).toBeUndefined();
    expect(body.store).toBeUndefined();

    // Verify tool name and call id encoding & lossless decoding
    const encodedToolName = body.tools[0].function.name;
    expect(encodedToolName).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(codec.decodeToolName(encodedToolName)).toBe('mcp:lark.edit_sheet');
    expect(body.tool_choice.function.name).toBe(encodedToolName);

    // Verify sheet cloaking preserves compound words, tool names, and property keys
    expect(body.messages[0].content).toBe(
      'Use docx/she\u200bet/bitable/slides and stylesheet.',
    );
    expect(body.messages[1].content[0].text).toBe('Check my She\u200bet please');
    expect(body.messages[1].content[1].image_url.url).toStartWith('data:image/jpeg;base64,');
    expect(body.messages[1].content[1].image_url.detail).toBe('auto');
    expect(body.messages[1].content[2].image_url.url).toStartWith('data:image/png;base64,');
    expect(body.messages[1].content[3]).toEqual({
      type: 'text',
      text: '[Image omitted: unsupported format image/gif]',
    });
    expect(body.tools[0].function.description).toBe(
      'Edit a she\u200bet and sheets in spreadsheet',
    );
    expect(
      Object.hasOwn(body.tools[0].function.parameters.properties, 'sheet'),
    ).toBe(true);
    expect(body.tools[0].function.parameters.properties.sheet.description).toBe(
      'Target She\u200bet id',
    );

    // Must pass strict OpenAI contract validator without throwing
    const normalized = normalizeChatRequest(body, { allowAutoModel: true });
    expect(normalized.thinking_level).toBe(2);
    // Unanswered call.weird:1 got flushed with aborted tool result before orphan
    expect(normalized.messages.some((m) => m.content === '[Tool execution aborted]')).toBe(
      true,
    );
  });

  test('maps Anthropic thinking and omits thinking fields on gemini-auto', () => {
    const disabled = _internal.sanitizeChatRequest({
      model: 'gemini-hydrogen',
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(disabled.body.thinking_level).toBe(0);

    const enabled = _internal.sanitizeChatRequest({
      model: 'gemini-hydrogen',
      thinking: { type: 'enabled', budget_tokens: 10000 },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(enabled.body.reasoning_effort).toBe('medium');

    const autoReq = _internal.sanitizeChatRequest({
      model: 'gemini-auto',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(autoReq.body.reasoning_effort).toBeUndefined();
    expect(autoReq.body.thinking_level).toBeUndefined();
  });
});

describe('createGeminiFetch end-to-end with mocked openTurn', () => {
  test('streams short and long OpenAI SSE responses and decodes tool calls', async () => {
    const toolCallResponseText =
      'Let me check.\n```tool_call\n{"name":"TOOL_PLACEHOLDER","arguments":{"sheet":"abc"}}\n```';

    const fetchFn = _internal.createGeminiFetch(
      async () => ({ type: 'oauth', access: 'valid-token' }),
      {
        getOption: () => true,
        deps: {
          openTurn: (_token, { messages }) => {
            const prompt = messages[0].content;
            // Verify sheet was cloaked on the wire prompt
            expect(prompt).toContain('she\u200bet');
            const match = /"name":"([A-Za-z0-9_-]+)"/.exec(prompt);
            const encodedName = match ? match[1] : 'tool';
            const replyText = toolCallResponseText.replace(
              'TOOL_PLACEHOLDER',
              encodedName,
            );
            return {
              events: (async function* () {
                yield { type: 'headers', httpStatus: 200 };
                yield {
                  type: 'frame',
                  bytes: buildNativeFrame(replyText.slice(0, 12), {
                    mode: 1,
                    complete: false,
                  }),
                };
                yield {
                  type: 'frame',
                  bytes: buildNativeFrame(replyText, { mode: 1, complete: true }),
                };
                yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
              })(),
              cancel() {},
              getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
            };
          },
        },
      },
    );

    const resp = await fetchFn('https://robinfrontend-pa.googleapis.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-hydrogen',
        stream: true,
        stream_options: { include_usage: true },
        tools: [
          {
            type: 'function',
            function: {
              name: 'mcp:demo.read_sheet',
              description: 'Read a sheet',
              parameters: {
                type: 'object',
                properties: { sheet: { type: 'string' } },
                required: ['sheet'],
              },
            },
          },
        ],
        messages: [{ role: 'user', content: 'Open sheet please' }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const body = await resp.text();
    expect(body).toContain('mcp:demo.read_sheet');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('data: [DONE]');
  });

  test('non-streaming completion returns JSON chat.completion', async () => {
    const fetchFn = _internal.createGeminiFetch(
      async () => ({ type: 'oauth', access: 'valid-token' }),
      {
        deps: {
          openTurn: () => ({
            events: (async function* () {
              yield {
                type: 'frame',
                bytes: buildNativeFrame('pong!', { mode: 1, complete: true }),
              };
              yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
            })(),
            cancel() {},
            getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
          }),
        },
      },
    );

    const resp = await fetchFn('https://robinfrontend-pa.googleapis.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-hydrogen',
        stream: false,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0].message.content).toBe('pong!');
    expect(json.choices[0].finish_reason).toBe('stop');
  });

  test('maps pre-output errors to real HTTP statuses and never stacks transport retries', async () => {
    // 1. 429 Quota exhausted
    const quotaFetch = _internal.createGeminiFetch(
      async () => ({ type: 'oauth', access: 'tok' }),
      {
        deps: {
          openTurn: () => ({
            events: (async function* () {
              yield { type: 'end', httpStatus: 429, grpcStatus: 8 };
            })(),
            cancel() {},
            getSafeStatus: () => ({ httpStatus: 429, grpcStatus: 8, ended: true }),
          }),
        },
      },
    );
    const r429 = await quotaFetch('https://x/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-hydrogen',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(r429.status).toBe(429);

    // 2. 401 Auth rejected (gRPC 16) -> NO X-Magpie-Sign-In so Magpie staleAccess refreshes
    const authFetch = _internal.createGeminiFetch(
      async () => ({ type: 'oauth', access: 'tok' }),
      {
        deps: {
          openTurn: () => ({
            events: (async function* () {
              const err = new Error('NATIVE_PERMISSION_OR_AUTH');
              err.code = 'NATIVE_PERMISSION_OR_AUTH';
              err.status = 403;
              throw err;
            })(),
            cancel() {},
            getSafeStatus: () => ({
              httpStatus: 200,
              grpcStatus: 16,
              ended: false,
            }),
          }),
        },
      },
    );
    const r401 = await authFetch('https://x/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-hydrogen',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(r401.status).toBe(401);
    expect(r401.headers.get('x-magpie-sign-in')).toBeNull();

    // 3. 403 Precondition (gRPC 9) -> X-Magpie-Sign-In: kept
    const tosFetch = _internal.createGeminiFetch(
      async () => ({ type: 'oauth', access: 'tok' }),
      {
        deps: {
          openTurn: () => ({
            events: (async function* () {
              yield { type: 'end', httpStatus: 200, grpcStatus: 9 };
            })(),
            cancel() {},
            getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 9, ended: true }),
          }),
        },
      },
    );
    const r403 = await tosFetch('https://x/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-hydrogen',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(r403.status).toBe(403);
    expect(r403.headers.get('x-magpie-sign-in')).toBe('kept');

    // 4. Transport failure fails fast in 1 attempt (no internal retry stacking)
    let transportAttempts = 0;
    const transportFetch = _internal.createGeminiFetch(
      async () => ({ type: 'oauth', access: 'tok' }),
      {
        deps: {
          openTurn: () => {
            transportAttempts++;
            return {
              events: (async function* () {
                const err = new Error('NATIVE_CONNECTION_FAILED');
                err.code = 'NATIVE_CONNECTION_FAILED';
                err.status = 502;
                throw err;
              })(),
              cancel() {},
              getSafeStatus: () => ({ httpStatus: null, grpcStatus: null, ended: false }),
            };
          },
        },
      },
    );
    const r502 = await transportFetch('https://x/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-hydrogen',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(r502.status).toBe(502);
    expect(transportAttempts).toBe(1);

    // 5. Truncated tool call in validate phase retries once internally with recovery instruction and succeeds
    let toolAttempts = 0;
    const retryToolFetch = _internal.createGeminiFetch(
      async () => ({ type: 'oauth', access: 'tok' }),
      {
        deps: {
          openTurn: () => {
            toolAttempts++;
            const currentAttempt = toolAttempts;
            return {
              events: (async function* () {
                const text =
                  currentAttempt === 1
                    ? '```tool_call\n{"name":"echo","arguments":{}}'
                    : '```tool_call\n{"name":"echo","arguments":{"x":"ok"}}\n```';
                yield {
                  type: 'frame',
                  bytes: buildNativeFrame(text, { mode: 1, complete: true }),
                };
                yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
              })(),
              cancel() {},
              getSafeStatus: () => ({ httpStatus: 200, grpcStatus: 0, ended: true }),
            };
          },
        },
      },
    );
    const rRecovered = await retryToolFetch('https://x/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-hydrogen',
        stream: false,
        tools: [
          {
            type: 'function',
            function: {
              name: 'echo',
              parameters: { type: 'object', properties: { x: { type: 'string' } } },
            },
          },
        ],
        messages: [{ role: 'user', content: 'run echo' }],
      }),
    });
    expect(rRecovered.status).toBe(200);
    expect(toolAttempts).toBe(2);
    const recoveredJson = await rRecovered.json();
    expect(recoveredJson.choices[0].message.tool_calls[0].function.name).toBe('echo');
  });
});

describe('auth.usage, auth.refresh & auth.methods', () => {
  test('usage decodes GetUsageInfo windows, omits null used, and handles refresh+retry', async () => {
    const payload = buildUsagePayload({
      tier: 2,
      rows: [
        { label: 'Current usage', fraction: 0.25, ts: 1800000000 },
        { label: 'Weekly limit', fraction: 0.4, ts: 1800500000 },
        { label: 'Unknown window', fraction: null },
      ],
    });
    let authSaves = [];
    let callCount = 0;
    const usageFn = _internal.createUsageHandler({
      client: {
        auth: {
          set: async ({ body }) => {
            authSaves.push(body);
            return { data: true };
          },
        },
      },
      deps: {
        fetchGoogleUsageInfo: async (token) => {
          callCount++;
          if (token === 'stale-tok') {
            throw Object.assign(new Error('QUOTA_AUTH_REJECTED'), {
              code: 'QUOTA_AUTH_REJECTED',
              status: 401,
            });
          }
          return { payload };
        },
        refreshOAuthCredential: async () => ({
          access: 'fresh-tok',
          refresh: 'new-ref',
          expires: Date.now() + 3600_000,
          subscriptionTier: 'pro',
          accountId: 'user@example.com',
          email: 'user@example.com',
          uid: 'sub-123',
        }),
      },
    });

    const result = await usageFn(async () => ({
      type: 'oauth',
      access: 'stale-tok',
      refresh: 'old-ref',
    }));
    expect(callCount).toBe(2);
    expect(result.signIn).toBe('renewed');
    expect(result.plan).toBe('AI Pro');
    expect(result.user).toBe('user@example.com');
    expect(result.windows).toHaveLength(3);
    expect(result.windows[0]).toEqual({
      name: 'Current usage',
      used: 25,
      resetsAt: new Date(1800000000 * 1000).toISOString(),
      span: 18000,
    });
    expect(result.windows[1].span).toBe(604800);
    expect(result.windows[1].used).toBe(40);
    expect('used' in result.windows[2]).toBe(false);
    expect(authSaves.length).toBeGreaterThanOrEqual(1);
    expect(authSaves.at(-1).access).toBe('fresh-tok');
  });

  test('auth.refresh merges renewed tokens and throws signIn=expired on invalid_grant', async () => {
    const renewed = await _internal.refreshOAuthCredential(
      { type: 'oauth', refresh: 'ref-1', access: 'old' },
      {
        deps: {
          refreshNativeCredential: async () => ({
            accessToken: 'acc-2',
            refreshToken: 'ref-2',
            expiresInSeconds: 3600,
          }),
          fetchGoogleIdentity: async () => ({
            email: 'ada@example.com',
            subject: 'sub_ada',
          }),
          fetchGoogleUsageInfo: async () => ({
            payload: buildUsagePayload({ tier: 3 }),
          }),
        },
      },
    );
    expect(renewed.access).toBe('acc-2');
    expect(renewed.refresh).toBe('ref-2');
    expect(renewed.subscriptionTier).toBe('ultra');
    expect(renewed.accountId).toBe('ada@example.com');
    expect(renewed.uid).toBe('sub_ada');

    let caught;
    try {
      await _internal.refreshOAuthCredential(
        { type: 'oauth', refresh: 'dead-ref' },
        {
          deps: {
            refreshNativeCredential: async () => {
              throw Object.assign(new Error('OAuth exchange rejected (HTTP 400)'), {
                code: 'invalid_grant',
              });
            },
          },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught?.signIn).toBe('expired');
  });

  test('auth.methods supports both auto browser loopback and manual code URL paste', async () => {
    let manualCallbackArgs = null;
    const fakeDeps = {
      startLoopbackLogin: async () => ({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=abc',
        done: Promise.resolve({
          accessToken: 'initial-acc',
          refreshToken: 'initial-ref',
          expiresInSeconds: 3600,
        }),
        close() {},
        completeCallbackUrl: async (raw) => {
          manualCallbackArgs = raw;
          return {
            accessToken: 'manual-acc',
            refreshToken: 'manual-ref',
            expiresInSeconds: 3600,
          };
        },
      }),
      refreshNativeCredential: async (_cfg, refresh) => ({
        accessToken: `scoped-${refresh}`,
        refreshToken: `scoped-ref-${refresh}`,
        expiresInSeconds: 3600,
      }),
      acceptGoogleMainTerms: async () => ({ status: 'accepted' }),
      fetchGoogleIdentity: async () => ({
        email: 'dev@example.com',
        subject: 'sub_dev',
      }),
      fetchGoogleUsageInfo: async () => ({
        payload: buildUsagePayload({ tier: 2 }),
      }),
    };

    const [browserMethod, manualMethod] = _internal.createOAuthMethods(fakeDeps);

    const authAuto = await browserMethod.authorize();
    expect(authAuto.method).toBe('auto');
    const resAuto = await authAuto.callback();
    expect(resAuto).toMatchObject({
      type: 'success',
      access: 'scoped-initial-ref',
      refresh: 'scoped-ref-initial-ref',
      accountId: 'dev@example.com',
      email: 'dev@example.com',
      uid: 'sub_dev',
      subscriptionTier: 'pro',
    });

    const authManual = await manualMethod.authorize();
    expect(authManual.method).toBe('code');
    const resManual = await authManual.callback('http://localhost:12345/?code=xyz&state=abc');
    expect(manualCallbackArgs).toBe('http://localhost:12345/?code=xyz&state=abc');
    expect(resManual.type).toBe('success');
    expect(resManual.access).toBe('scoped-manual-ref');
  });
});
