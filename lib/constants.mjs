export const PROVIDER_ID = 'gemini-app';
export const PROVIDER_NAME = 'Google Gemini App';
export const BASE_URL = 'https://robinfrontend-pa.googleapis.com';
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;

export const SUBSCRIPTION_LABELS = Object.freeze({
  free: 'Free',
  plus: 'AI Plus',
  pro: 'AI Pro',
  ultra: 'AI Ultra',
  ultra_neon: 'Ultra/Neon',
});

export const MODEL_DEFS = Object.freeze([
  Object.freeze({
    id: 'gemini-neon',
    name: 'Gemini Neon',
    context: 512000,
    output: 16384,
    reasoning: true,
    variants: Object.freeze({
      minimal: {},
      low: {},
      medium: {},
      high: {},
      xhigh: {},
    }),
    image: true,
  }),
  Object.freeze({
    id: 'gemini-hydrogen',
    name: 'Gemini Hydrogen',
    context: 512000,
    output: 16384,
    reasoning: true,
    variants: Object.freeze({
      minimal: {},
      low: {},
      medium: {},
      high: {},
      xhigh: {},
    }),
    image: true,
  }),
  Object.freeze({
    id: 'gemini-flash-lite',
    name: 'Gemini Flash Lite',
    context: 128000,
    output: 8192,
    reasoning: true,
    variants: Object.freeze({
      minimal: {},
      low: {},
      medium: {},
      high: {},
      xhigh: {},
    }),
    image: true,
  }),
  Object.freeze({
    id: 'gemini-auto',
    name: 'Gemini Auto',
    context: 128000,
    output: 8192,
    reasoning: false,
    variants: Object.freeze({}),
    image: true,
  }),
]);

export function buildConfigModels() {
  const models = {};
  for (const def of MODEL_DEFS) {
    models[def.id] = {
      id: def.id,
      name: def.name,
      limit: { context: def.context, output: def.output },
      reasoning: def.reasoning,
      tool_call: true,
      attachment: def.image,
      modalities: {
        input: def.image ? ['text', 'image'] : ['text'],
        output: ['text'],
      },
      variants: { ...def.variants },
    };
  }
  return models;
}

export function buildProviderModels(tier) {
  const defs =
    tier === 'free'
      ? MODEL_DEFS.filter((def) => def.id === 'gemini-auto')
      : MODEL_DEFS;
  const out = {};
  for (const def of defs) {
    out[def.id] = {
      id: def.id,
      providerID: PROVIDER_ID,
      name: def.name,
      api: {
        id: def.id,
        url: BASE_URL,
        npm: '@ai-sdk/openai-compatible',
      },
      status: 'active',
      headers: {},
      options: {},
      limit: { context: def.context, output: def.output },
      capabilities: {
        temperature: true,
        reasoning: def.reasoning,
        attachment: def.image,
        toolcall: true,
        input: {
          text: true,
          image: def.image,
          audio: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          image: false,
          audio: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      release_date: '',
      variants: { ...def.variants },
    };
  }
  return out;
}
