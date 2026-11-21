import {
  BASE_URL,
  MODEL_DEFS,
  PROVIDER_ID,
  PROVIDER_NAME,
  SUBSCRIPTION_LABELS,
  buildConfigModels,
  buildProviderModels,
} from './lib/constants.mjs';
import {
  SHEET_TRIGGER_RE,
  cloakChatBody,
  cloakResponsesBody,
  cloakSchemaDescriptions,
  cloakText,
} from './lib/cloak.mjs';
import { createGeminiFetch, createWebResponseAdapter, mapErrorToHttp } from './lib/fetch.mjs';
import { fetchGoogleIdentity, validateGoogleIdentity } from './lib/identity.mjs';
import {
  computeExpiresAtMs,
  createOAuthMethods,
  detectSubscriptionTier,
  dynamicHttp2Connect,
  refreshOAuthCredential,
  resolveOAuthConfig,
} from './lib/oauth.mjs';
import {
  createToolCodec,
  sanitizeChatRequest,
  sanitizeResponsesRequest,
} from './lib/sanitize.mjs';
import { createUsageHandler, formatMagpieUsage, inferWindowSpan } from './lib/usage.mjs';

const CLOAK_SHEET_OPTION = {
  key: 'cloak_sheet',
  label: 'Work around Gemini "sheet" stall',
  labels: {
    zh: '绕过 Gemini "sheet" 词卡死问题',
    'zh-TW': '繞過 Gemini "sheet" 詞卡死問題',
  },
  description:
    'Insert a zero-width space into standalone "sheet" words in prompts and tool descriptions to prevent Google ProcessQuery from hanging.',
  descriptions: {
    zh: '在提示词与工具描述中的独立单词 "sheet" 内插入零宽空格，避免 Google 上游卡死超时（不修改工具名或参数键）。',
    'zh-TW': '在提示詞與工具描述中的獨立單字 "sheet" 內插入零寬空格，避免 Google 上游卡死逾時（不修改工具名或參數鍵）。',
  },
  default: true,
};

const GeminiAppPlugin = async (input = {}) => {
  const client = input?.client;
  const getOption = (key) => input?.magpie?.option?.(PROVIDER_ID, key);

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER_ID] ??= {
        name: PROVIDER_NAME,
        npm: '@ai-sdk/openai-compatible',
        api: BASE_URL,
        models: buildConfigModels(),
      };
    },

    auth: {
      provider: PROVIDER_ID,
      maxConcurrency: 4,
      refreshLead: 5 * 60 * 1000,
      options: [CLOAK_SHEET_OPTION],
      methods: createOAuthMethods(),
      refresh: async (auth) => refreshOAuthCredential(auth),
      usage: createUsageHandler({ client }),
      async loader(getAuth) {
        return {
          baseURL: BASE_URL,
          fetch: createGeminiFetch(getAuth, { getOption }),
        };
      },
    },

    provider: {
      id: PROVIDER_ID,
      async models(_given, { auth, signal } = {}) {
        let tier =
          auth?.type === 'oauth' && typeof auth.subscriptionTier === 'string'
            ? auth.subscriptionTier
            : 'unknown';
        if (
          tier === 'unknown' &&
          auth?.type === 'oauth' &&
          typeof auth.access === 'string' &&
          auth.access
        ) {
          tier = await detectSubscriptionTier(auth.access, {
            signal,
            connect: dynamicHttp2Connect,
          });
          if (tier !== 'unknown') {
            await client?.auth?.set?.({
              path: { id: PROVIDER_ID },
              body: { ...auth, subscriptionTier: tier },
            });
          }
        }
        return buildProviderModels(tier);
      },
    },
  };
};

export default {
  id: 'opencode-gemini-app-auth',
  server: GeminiAppPlugin,
};

export const _internal = {
  BASE_URL,
  MODEL_DEFS,
  PROVIDER_ID,
  PROVIDER_NAME,
  SHEET_TRIGGER_RE,
  SUBSCRIPTION_LABELS,
  buildConfigModels,
  buildProviderModels,
  cloakChatBody,
  cloakResponsesBody,
  cloakSchemaDescriptions,
  cloakText,
  computeExpiresAtMs,
  createGeminiFetch,
  createOAuthMethods,
  createToolCodec,
  createUsageHandler,
  createWebResponseAdapter,
  detectSubscriptionTier,
  dynamicHttp2Connect,
  fetchGoogleIdentity,
  formatMagpieUsage,
  inferWindowSpan,
  mapErrorToHttp,
  refreshOAuthCredential,
  resolveOAuthConfig,
  sanitizeChatRequest,
  sanitizeResponsesRequest,
  validateGoogleIdentity,
};
