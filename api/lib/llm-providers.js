// Provider registry — the "phone book" for LLM endpoints.
//
// Each entry pins the OpenAI-compatible endpoint and default model for one
// upstream provider, and names the env var that holds its key. Keys NEVER
// live here — they stay in the platform environment (Vercel env vars), one
// per provider, all coexisting.
//
// Selection order in api/mentor-table.js:
//   request body `provider`  >  env LLM_PROVIDER  >  legacy env config
// (request param and LLM_PROVIDER must match a name here; with neither set,
// the legacy single-provider env config applies unchanged).
//
// Adding a provider = add an entry here + set its key env var. Switching =
// pass a different `provider` value — no deploy needed for per-request
// switches; the registry itself changes only through a normal code review.

const PROVIDERS = {
  dashscope: {
    label: 'Alibaba DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-max',
    apiKeyEnv: 'LLM_API_KEY'
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY'
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY'
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

module.exports = {
  PROVIDERS,
  isKnownProvider,
  listProviderNames,
  providerErrorHint
};
