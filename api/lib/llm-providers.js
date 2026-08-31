// Provider registry — the "phone book" for LLM endpoints.
//
// Each entry pins the upstream endpoint and default model for one provider,
// names the env var(s) holding its key, and declares the wire protocol.
// Keys NEVER live here — they stay in the platform environment (Vercel env
// vars), one per provider, all coexisting.
//
// Selection order in api/mentor-table.js:
//   request body `provider`  >  env LLM_PROVIDER  >  legacy env config
// (request param and LLM_PROVIDER must match a name here; with neither set,
// the legacy single-provider env config applies unchanged).
//
// Adding a provider = add an entry here + set its key env var. Switching =
// pass a different `provider` value — no deploy needed for per-request
// switches; the registry itself changes only through a normal code review.
//
// protocol: 'openai'    -> OpenAI-compatible chat/completions (Bearer auth,
//                          response_format; the default for most providers)
//           'anthropic' -> Anthropic-native /v1/messages (x-api-key header,
//                          top-level system, max_tokens required). The
//                          baseUrl/model honor env overrides so relay
//                          endpoints (ANTHROPIC_API_BASE) work without a
//                          code change.

const PROVIDERS = {
  dashscope: {
    label: 'Alibaba DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-max',
    // First env var that holds a value wins. DASHSCOPE_API_KEY is the
    // provider-native name; LLM_API_KEY is the legacy name this repo's
    // deployments already have configured.
    apiKeyEnvs: ['DASHSCOPE_API_KEY', 'LLM_API_KEY'],
    protocol: 'openai',
    // Ordered model fallback list: tried left to right before the chain
    // moves to the next provider. DashScope hosts many vendors' models
    // (qwen, deepseek-v3, kimi-k2, glm...) under DashScope's own model IDs
    // — which differ from the vendors' direct-API IDs. The override is
    // per-provider env, comma-separated for multiple entries, never a
    // cross-provider shared name.
    // IDs verified live against GET /compatible-mode/v1/models (2026-08-31):
    // glm-5 and kimi-k3 both complete chat requests on this account.
    models: ['qwen3-max', 'glm-5', 'kimi-k3'],
    envOverrides: { models: ['DASHSCOPE_MODEL'] }
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnvs: ['DEEPSEEK_API_KEY'],
    protocol: 'openai',
    // IDs verified live against GET /models (2026-08-31): the v3-era
    // deepseek-chat alias no longer appears; v4 is current. Both are
    // hybrid reasoning models — they emit reasoning_content plus content,
    // so leave headroom for thinking tokens in any max_tokens decision.
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    envOverrides: { models: ['DEEPSEEK_MODEL'] }
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnvs: ['OPENAI_API_KEY'],
    protocol: 'openai',
    models: ['gpt-4o-mini'],
    envOverrides: { models: ['OPENAI_MODEL'] }
  },
  claude: {
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com',
    // Ordered list. ANTHROPIC_MODEL_1 and _2 are concatenated in order
    // (comma-separated values inside each are honored too), so both of the
    // user's configured models participate in fallback.
    models: ['claude-sonnet-4-5', 'claude-opus-4-6'],
    apiKeyEnvs: ['ANTHROPIC_API_KEY_1', 'ANTHROPIC_API_KEY_2'],
    protocol: 'anthropic',
    // Relay-friendly: the endpoint and model can be pointed at any
    // Anthropic-protocol relay via env, without touching code.
    envOverrides: {
      baseUrl: ['ANTHROPIC_API_BASE', 'ANTHROPIC_BASE_URL'],
      models: ['ANTHROPIC_MODEL_1', 'ANTHROPIC_MODEL_2']
    }
  }
};

function isKnownProvider(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, name);
}

function listProviderNames() {
  return Object.keys(PROVIDERS);
}

function providerErrorHint() {
  return `valid providers: ${listProviderNames().join(', ')}`;
}

// Resolves one entry per call so env overrides are always current (env vars
// change per deployment; a require-time snapshot would freeze stale values
// into the serverless instance).
function getProvider(name) {
  if (!isKnownProvider(name)) return null;
  const entry = PROVIDERS[name];
  const firstEnv = (names) => {
    for (const n of names || []) {
      const v = process.env[n];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  // Model override: every listed env var that is set contributes its
  // comma-separated values, in order. ANTHROPIC_MODEL_1=a,ANTHROPIC_MODEL_2=b
  // therefore resolves to the fallback list [a, b].
  let models = entry.models;
  const modelEnvs = entry.envOverrides && entry.envOverrides.models;
  if (modelEnvs && modelEnvs.length) {
    const values = [];
    for (const name of modelEnvs) {
      const v = process.env[name];
      if (typeof v !== 'string') continue;
      for (const part of v.split(',')) {
        const trimmed = part.trim();
        if (trimmed && !values.includes(trimmed)) values.push(trimmed);
      }
    }
    if (values.length) models = values;
  }
  return {
    ...entry,
    baseUrl: (entry.envOverrides && firstEnv(entry.envOverrides.baseUrl)) || entry.baseUrl,
    models
  };
}

module.exports = {
  PROVIDERS,
  getProvider,
  isKnownProvider,
  listProviderNames,
  providerErrorHint
};
