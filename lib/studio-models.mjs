// Anthropic release metadata, verified 2026-09-23:
// https://platform.claude.com/docs/en/models/opus-5-5/overview
import { register } from 'node:module';
import { realpathSync } from 'node:fs';

export const ANTHROPIC_OPUS_55 = {
  id: 'claude-opus-5-5',
  name: 'Claude Opus 5.5',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
  input: ['text', 'image'],
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  contextWindow: 1000000,
  maxTokens: 128000,
};

// OpenAI release metadata, verified 2026-09-23:
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
export const OPENAI_GPT6_MODELS = [
  {
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
].map((model) => ({
  ...model,
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: true,
  thinkingLevelMap: { off: 'none', minimal: null, xhigh: 'xhigh', max: 'max' },
  input: ['text', 'image'],
  contextWindow: 1050000,
  maxTokens: 128000,
}));

// Codex sign-in is separate from API billing. Limits/efforts were verified
// against its authenticated model catalog using the current official client
// version. Keep the native account entitlement check; this grants no access.
export const OPENAI_CODEX_GPT6_MODELS = OPENAI_GPT6_MODELS.map((model) => ({
  ...model,
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh', max: 'max' },
  contextWindow: 272000,
}));

export const STUDIO_MODELS = [ANTHROPIC_OPUS_55, ...OPENAI_GPT6_MODELS, ...OPENAI_CODEX_GPT6_MODELS];

// https://github.com/openai/codex/releases/tag/rust-v0.156.1
// 0.153.4 omits Sol/Luna; 0.156.1 includes them for eligible accounts.
export const CODEX_CATALOG_CLIENT_VERSION = '0.156.1';

// Opus 5.5 OAuth requests require Claude Code 2.1.280 or newer.
// https://code.claude.com/docs/en/changelog
// Raise only the native adapter's default identity, not user header overrides.
export const ANTHROPIC_CLAUDE_CODE_CLIENT_VERSION = '2.1.280';

const registered = new Set();

// Direct server/worker imports need the same compatibility layer as native
// agents. Runtime processes inherit it through Studio's transport loader.
export function registerStudioModelSupport(packageDir) {
  const packageRoot = realpathSync(packageDir);
  if (registered.has(packageRoot)) return;
  register('../runtime/studio-models-hook.mjs', import.meta.url, { data: { packageRoot } });
  registered.add(packageRoot);
}
