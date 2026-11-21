import { EventEmitter } from 'node:events';
import {
  buildCanonicalPrompt,
  normalizeChatRequest,
  normalizeResponsesRequest,
} from '../core/src/openai-contract.mjs';
import { NativeDirectProvider as DefaultNativeDirectProvider } from '../core/src/native-provider.mjs';
import { openDirectTurn as defaultOpenDirectTurn } from '../core/src/gateway/native-transport.mjs';
import { uploadNativeImages as defaultUploadNativeImages } from '../core/src/gateway/image-upload.mjs';
import { automaticRecoveryKind as defaultAutomaticRecoveryKind } from '../core/src/gateway/automatic-recovery.mjs';
import { createResponseDelivery } from '../core/src/gateway/response-delivery.mjs';
import { protocolError } from '../core/src/tool-protocol.mjs';
import { DEFAULT_TURN_TIMEOUT_MS } from './constants.mjs';
import { dynamicHttp2Connect } from './oauth.mjs';
import { sanitizeChatRequest, sanitizeResponsesRequest } from './sanitize.mjs';

const PROTOCOL_RECOVERY_KINDS = new Set([
  'tool_protocol',
  'structured_output',
  'incomplete_response',
  'provider_soft_error',
]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'keep-alive',
]);

export function resolveTurnTimeoutMs(env = process.env) {
  const configured = Number(env?.GEMINI_TURN_TIMEOUT_MS);
  if (
    Number.isInteger(configured) &&
    configured >= 5000 &&
    configured <= 600_000
  ) {
    return configured;
  }
  return DEFAULT_TURN_TIMEOUT_MS;
}

function decodeCall(call, codec) {
  if (!call || typeof call !== 'object' || !call.function) return call;
  return {
    ...call,
    id: codec.decodeToolCallId(call.id),
    function: {
      ...call.function,
      name: codec.decodeToolName(call.function.name),
    },
  };
}

export function mapErrorToHttp(error, modelId) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'NATIVE_TURN_FAILED';
  const upstreamMsg =
    typeof error?.nativeEvidence?.upstreamMessage === 'string' &&
    error.nativeEvidence.upstreamMessage.length > 0
      ? error.nativeEvidence.upstreamMessage
      : '';

  if (
    error?.status === 429 ||
    code === 'NATIVE_RATE_LIMITED' ||
    code === 'NATIVE_QUOTA_EXHAUSTED' ||
    code === 'NATIVE_QUOTA_INSUFFICIENT'
  ) {
    return {
      status: 429,
      headers: {},
      body: {
        error: {
          message: `Google Gemini quota exhausted for ${modelId || 'this model'} [${code}].`,
          type: 'rate_limit_error',
          code,
        },
      },
    };
  }

  const isAuth401 =
    error?.status === 401 ||
    code === 'ACCOUNT_LOGIN_REQUIRED' ||
    code === 'NATIVE_AUTH_REJECTED' ||
    code === 'NATIVE_CREDENTIAL_REQUIRED' ||
    (code === 'NATIVE_PERMISSION_OR_AUTH' &&
      (error?.nativeEvidence?.upstreamHttpStatus === 401 ||
        error?.nativeEvidence?.grpcStatus === 16));

  if (isAuth401) {
    return {
      status: 401,
      headers: {},
      body: {
        error: {
          message: `Google Gemini authentication rejected or expired [${code}].`,
          type: 'authentication_error',
          code,
        },
      },
    };
  }

  if (
    error?.status === 403 ||
    code === 'NATIVE_PRECONDITION_REQUIRED' ||
    code === 'MODEL_DOWNGRADE_REJECTED' ||
    code === 'NATIVE_PERMISSION_REJECTED' ||
    code === 'NATIVE_PERMISSION_OR_AUTH'
  ) {
    let message = `Google Gemini refused the request [${code}]${upstreamMsg ? `: ${upstreamMsg}` : ''}`;
    if (code === 'NATIVE_PRECONDITION_REQUIRED') {
      if (/terms of service|tos_not_accepted/i.test(upstreamMsg)) {
        message = `Google Gemini Terms of Service not accepted [${code}]: ${upstreamMsg}`;
      } else if (/requires_advanced|mismatched_bard_mode|invalid_bard_mode/i.test(upstreamMsg)) {
        message = `Model ${modelId || ''} requires a paid Google AI subscription [${code}]: ${upstreamMsg}`;
      }
    } else if (code === 'MODEL_DOWNGRADE_REJECTED') {
      message = `Requested model (${modelId || 'selected model'}) was downgraded or unavailable for this account [${code}].`;
    }
    return {
      status: 403,
      headers: { 'x-magpie-sign-in': 'kept' },
      body: {
        error: {
          message,
          type: 'permission_error',
          code,
        },
      },
    };
  }

  if (
    error?.status === 413 ||
    code === 'PROMPT_TOO_LARGE' ||
    code === 'REQUEST_TOO_LARGE' ||
    code === 'IMAGE_COUNT_EXCEEDED' ||
    code === 'IMAGE_TOO_LARGE' ||
    code === 'IMAGES_TOO_LARGE' ||
    code === 'IMAGE_DIMENSIONS_TOO_LARGE' ||
    code === 'NATIVE_SEARCH_PROMPT_TOO_LARGE'
  ) {
    return {
      status: 413,
      headers: {},
      body: {
        error: {
          message: error?.message || `Request exceeds size limit [${code}]`,
          type: 'invalid_request_error',
          code,
        },
      },
    };
  }

  if (
    error?.status === 422 ||
    code === 'NATIVE_RESPONSE_REFUSED' ||
    code === 'NATIVE_OUTPUT_NOT_TEXT' ||
    code === 'NATIVE_DEEP_THINK_UNSUPPORTED' ||
    code === 'NATIVE_ASYNC_RESPONSE_UNSUPPORTED'
  ) {
    return {
      status: 422,
      headers: {},
      body: {
        error: {
          message: `Google Gemini refused or could not complete output [${code}]${upstreamMsg ? `: ${upstreamMsg}` : ''}`,
          type: 'invalid_request_error',
          code,
        },
      },
    };
  }

  if (
    error?.status === 499 ||
    code === 'NATIVE_TURN_ABORTED' ||
    code === 'REQUEST_CANCELLED'
  ) {
    return {
      status: 499,
      headers: {},
      body: {
        error: {
          message: 'Request was cancelled.',
          type: 'api_error',
          code,
        },
      },
    };
  }

  if (
    error?.status === 504 ||
    code === 'NATIVE_TURN_TIMEOUT' ||
    code === 'NATIVE_TRANSPORT_TIMEOUT'
  ) {
    return {
      status: 504,
      headers: {},
      body: {
        error: {
          message: `Google Gemini request timed out [${code}].`,
          type: 'api_error',
          code,
        },
      },
    };
  }

  if (error?.status === 503 || code === 'NATIVE_UPSTREAM_UNAVAILABLE') {
    return {
      status: 503,
      headers: {},
      body: {
        error: {
          message: `Google Gemini upstream temporarily unavailable [${code}].`,
          type: 'api_error',
          code,
        },
      },
    };
  }

  if (error?.status === 400) {
    return {
      status: 400,
      headers: {},
      body: {
        error: {
          message: `${error?.message || 'Invalid request'} [${code}]${error?.param ? ` (param: ${error.param})` : ''}`,
          type: 'invalid_request_error',
          code,
          ...(error?.param ? { param: error.param } : {}),
        },
      },
    };
  }

  return {
    status: 502,
    headers: {},
    body: {
      error: {
        message: `Native response failed verification: [${code}]${upstreamMsg ? ` — ${upstreamMsg}` : ''}`,
        type: 'api_error',
        code,
      },
    },
  };
}

function filterHeaders(rawHeaders = {}) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v === undefined || v === null) continue;
    if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  return headers;
}

export function createWebResponseAdapter({ stream = false, onCancel } = {}) {
  const encoder = new TextEncoder();
  const emitter = new EventEmitter();
  const bufferedChunks = [];

  let controller = null;
  let headResolved = false;
  let resolveHead;
  const headReady = new Promise((resolve) => {
    resolveHead = resolve;
  });

  const settleHead = (response) => {
    if (headResolved) return;
    headResolved = true;
    resolveHead(response);
  };

  const readableStream = stream
    ? new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel() {
          res.destroyed = true;
          emitter.emit('close');
          onCancel?.();
        },
      })
    : null;

  let responseStatus = 200;
  let responseHeaders = new Headers();

  const res = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    statusCode: 200,
    incomplete: false,
    once(event, listener) {
      emitter.once(event, listener);
      return res;
    },
    off(event, listener) {
      emitter.off(event, listener);
      return res;
    },
    setHeader(name, value) {
      if (!res.headersSent && !HOP_BY_HOP_HEADERS.has(String(name).toLowerCase())) {
        responseHeaders.set(String(name), String(value));
      }
    },
    writeHead(statusCode, rawHeaders = {}) {
      if (res.headersSent) return res;
      res.headersSent = true;
      res.statusCode = statusCode;
      responseStatus = statusCode;
      const merged = filterHeaders(rawHeaders);
      for (const [k, v] of responseHeaders.entries()) {
        if (!merged.has(k)) merged.set(k, v);
      }
      responseHeaders = merged;
      if (stream) {
        settleHead(
          new Response(readableStream, {
            status: responseStatus,
            headers: responseHeaders,
          }),
        );
      }
      return res;
    },
    flushHeaders() {},
    write(chunk) {
      if (res.destroyed || res.writableEnded) return false;
      const bytes =
        typeof chunk === 'string'
          ? encoder.encode(chunk)
          : Buffer.isBuffer(chunk)
            ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : chunk instanceof Uint8Array
              ? chunk
              : encoder.encode(String(chunk));
      if (stream) {
        try {
          controller?.enqueue(bytes);
        } catch {
          return false;
        }
      } else {
        bufferedChunks.push(Buffer.from(bytes));
      }
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        res.write(chunk);
      }
      res.writableEnded = true;
      if (stream) {
        try {
          controller?.close();
        } catch {}
        if (!headResolved) {
          settleHead(
            new Response(readableStream, {
              status: responseStatus,
              headers: responseHeaders,
            }),
          );
        }
      } else {
        settleHead(
          new Response(Buffer.concat(bufferedChunks), {
            status: responseStatus,
            headers: responseHeaders,
          }),
        );
      }
      return res;
    },
    destroy() {
      if (res.destroyed) return res;
      res.destroyed = true;
      if (stream) {
        try {
          controller?.close();
        } catch {}
      }
      emitter.emit('close');
      onCancel?.();
      if (!headResolved) {
        failBeforeStart(mapErrorToHttp(protocolError('REQUEST_CANCELLED', 499)));
      }
      return res;
    },
  };

  function failBeforeStart(httpErr) {
    if (headResolved || res.headersSent) return false;
    const headers = filterHeaders({
      'content-type': 'application/json',
      ...(httpErr.headers || {}),
    });
    res.writableEnded = true;
    settleHead(
      new Response(JSON.stringify(httpErr.body), {
        status: httpErr.status,
        headers,
      }),
    );
    return true;
  }

  return { res, headReady, failBeforeStart };
}

function jsonErrorResponse(httpErr) {
  return new Response(JSON.stringify(httpErr.body), {
    status: httpErr.status,
    headers: filterHeaders({
      'content-type': 'application/json',
      ...(httpErr.headers || {}),
    }),
  });
}

async function readJsonBody(init) {
  if (!init?.body) return null;
  if (typeof init.body === 'string') {
    return JSON.parse(init.body);
  }
  if (init.body instanceof Uint8Array || ArrayBuffer.isView(init.body)) {
    return JSON.parse(new TextDecoder().decode(init.body));
  }
  if (init.body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(init.body)));
  }
  return JSON.parse(await new Response(init.body).text());
}

export function createGeminiFetch(getAuth, { getOption, deps = {} } = {}) {
  const NativeDirectProvider =
    deps.NativeDirectProvider || DefaultNativeDirectProvider;
  const openTurn =
    deps.openTurn ||
    ((token, opts) =>
      defaultOpenDirectTurn(token, opts, { connect: dynamicHttp2Connect }));
  const uploadImages =
    deps.uploadImages ||
    ((token, images, opts) =>
      defaultUploadNativeImages(token, images, opts, {
        connect: dynamicHttp2Connect,
      }));
  const automaticRecoveryKind =
    deps.automaticRecoveryKind || defaultAutomaticRecoveryKind;
  const timeoutMs = deps.timeoutMs ?? resolveTurnTimeoutMs(deps.env);

  return async function geminiFetch(input, init = {}) {
    let rawBody;
    try {
      rawBody = await readJsonBody(init);
    } catch {
      return jsonErrorResponse(
        mapErrorToHttp(protocolError('INVALID_JSON', 400)),
      );
    }

    const auth = await getAuth();
    if (!auth || typeof auth.access !== 'string' || !auth.access) {
      return jsonErrorResponse(
        mapErrorToHttp(protocolError('NATIVE_CREDENTIAL_REQUIRED', 401)),
      );
    }

    const urlStr = typeof input === 'string' ? input : input?.url || '';
    const isResponsesRoute = /\/responses(?:\?|$)/.test(urlStr);
    const cloakSheet = getOption ? getOption('cloak_sheet') !== false : true;

    let sanitized;
    let canonical;
    let promptChars = 0;
    try {
      if (isResponsesRoute) {
        sanitized = sanitizeResponsesRequest(rawBody, { cloakSheet });
        canonical = normalizeResponsesRequest(sanitized.body, {
          allowAutoModel: true,
        }).body;
      } else {
        sanitized = sanitizeChatRequest(rawBody, { cloakSheet });
        canonical = normalizeChatRequest(sanitized.body, {
          allowAutoModel: true,
        });
      }
      const canonicalPrompt = buildCanonicalPrompt(canonical);
      promptChars = canonicalPrompt.messages[0]?.content?.length ?? 0;
    } catch (error) {
      return jsonErrorResponse(mapErrorToHttp(error, rawBody?.model));
    }

    const requestController = new AbortController();
    const upstreamSignal = init?.signal;
    const onUpstreamAbort = () => {
      requestController.abort(upstreamSignal?.reason);
    };
    if (upstreamSignal?.aborted) {
      return jsonErrorResponse(
        mapErrorToHttp(protocolError('REQUEST_CANCELLED', 499), canonical.model),
      );
    }
    upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true });

    const adapter = createWebResponseAdapter({
      stream: sanitized.stream,
      onCancel: () => {
        requestController.abort(protocolError('REQUEST_CANCELLED', 499));
      },
    });

    const delivery = createResponseDelivery(adapter.res, {
      route: sanitized.route,
      stream: sanitized.stream,
      includeUsage: sanitized.includeUsage,
      model: canonical.model,
      thinkingLevel: canonical.thinking_level,
      reasoningEffort: canonical.reasoning_effort ?? canonical.reasoning?.effort,
      parallelToolCalls: canonical.parallel_tool_calls ?? true,
      promptChars,
      deferEmptyStart: true,
      signal: requestController.signal,
    });

    const provider = new NativeDirectProvider(
      {
        getValidAccessToken: async () => {
          const latest = await getAuth();
          if (!latest || typeof latest.access !== 'string' || !latest.access) {
            throw protocolError('NATIVE_CREDENTIAL_REQUIRED', 401);
          }
          return latest.access;
        },
      },
      {
        openTurn,
        uploadImages,
        ...(deps.downloadImages ? { downloadImages: deps.downloadImages } : {}),
        timeoutMs,
        modelAlias: canonical.model,
        allowAutoModel: true,
      },
    );

    const codec = sanitized.codec;
    const onDelta = async (event) => {
      if (event?.call) {
        await delivery.accept({
          ...event,
          call: decodeCall(event.call, codec),
        });
      } else {
        await delivery.accept(event);
      }
    };

    (async () => {
      let attempts = 0;
      let recoveryCode;
      try {
        while (true) {
          try {
            const turnResult = await provider.runTurn(
              'magpie-session',
              canonical,
              onDelta,
              {
                incrementalOutput: true,
                outputMode: sanitized.stream ? 'stream' : 'buffered',
                signal: requestController.signal,
                timeoutMs,
                recoveryCode,
                getOutputCommitState: delivery.outputCommitState,
              },
            );
            const decodedResult = {
              ...turnResult,
              calls: (turnResult.calls || []).map((c) => decodeCall(c, codec)),
            };
            await delivery.complete(decodedResult);
            break;
          } catch (turnError) {
            if (
              !delivery.started &&
              attempts === 0 &&
              !requestController.signal.aborted &&
              turnError?.code !== 'NATIVE_TURN_ABORTED' &&
              turnError?.code !== 'REQUEST_CANCELLED'
            ) {
              const kind = automaticRecoveryKind(turnError, canonical.model, {
                allowAutoModel: true,
              });
              if (PROTOCOL_RECOVERY_KINDS.has(kind)) {
                attempts++;
                recoveryCode = turnError.code;
                delivery.discard();
                continue;
              }
            }
            throw turnError;
          }
        }
      } catch (error) {
        if (delivery.started) {
          const patched = error?.partialResult
            ? Object.assign(error, {
                partialResult: {
                  ...error.partialResult,
                  calls: (error.partialResult.calls || []).map((c) =>
                    decodeCall(c, codec),
                  ),
                },
              })
            : error;
          try {
            await delivery.interrupt(patched);
          } catch {
            adapter.res.destroy();
          }
        } else {
          adapter.failBeforeStart(mapErrorToHttp(error, canonical.model));
        }
      } finally {
        upstreamSignal?.removeEventListener('abort', onUpstreamAbort);
      }
    })();

    return adapter.headReady;
  };
}
