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

// https://platform.claude.com/docs/en/models/fable-5-2/overview (verified 2026-11-11)
export const ANTHROPIC_FABLE_52 = {
  id: 'claude-fable-5-2',
  name: 'Claude Fable 5.2',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
  input: ['text', 'image'],
  cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  contextWindow: 1000000,
  maxTokens: 128000,
};

// OpenAI release metadata: GPT-6 verified 2026-09-23; GPT-6.1 Sol 2026-09-29.
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/models/gpt-6.1-terra (verified 2026-10-27)
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
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh', max: 'max' },
  },
  {
    id: 'gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
  },
].map((model) => ({
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: true,
  thinkingLevelMap: { off: 'none', minimal: null, xhigh: 'xhigh', max: 'max' },
  input: ['text', 'image'],
  contextWindow: 1050000,
  maxTokens: 128000,
  ...model,
}));

// Codex sign-in is separate from API billing. Keep its per-model default context:
// Terra: 500K (not the 872K max), minimum client 0.153.0; existing 0.159.1 suffices.
// https://github.com/openai/codex/blob/126a0ee92ed2c5e73cd8a8f7e37563e8527552d7/codex-rs/models-manager/models.json
// Sol/Luna verified against the authenticated catalog; GPT-6.1 Sol against
// https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/models-manager/models.json
// The API output cap is Studio's budget, not a documented subscription limit.
// Keep the native account entitlement check; this grants no access.
export const OPENAI_CODEX_GPT6_MODELS = OPENAI_GPT6_MODELS.map((model) => ({
  ...model,
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh', max: 'max' },
  contextWindow: model.id === 'gpt-6.1-terra' ? 500000 : 272000,
}));

export const STUDIO_MODELS = [
  ANTHROPIC_OPUS_55,
  ANTHROPIC_FABLE_52,
  ...OPENAI_GPT6_MODELS,
  ...OPENAI_CODEX_GPT6_MODELS,
];

// https://github.com/openai/codex/releases/tag/rust-v0.159.1
// Official client release that added GPT-6.1 Sol to its bundled catalog.
// This is a known client identity, not a claim about the minimum server version.
export const CODEX_CATALOG_CLIENT_VERSION = '0.159.1';

// Fable 5.2 requires Claude Code 2.1.321 or newer (also covers Opus 5.5).
// https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan
// Raise only the native adapter's default identity, not user header overrides.
export const ANTHROPIC_CLAUDE_CODE_CLIENT_VERSION = '2.1.321';

const registered = new Set();

// Direct server/worker imports need the same compatibility layer as native
// agents. Runtime processes inherit it through Studio's transport loader.
export function registerStudioModelSupport(packageDir) {
  const packageRoot = realpathSync(packageDir);
  if (registered.has(packageRoot)) return;
  register('../runtime/studio-models-hook.mjs', import.meta.url, { data: { packageRoot } });
  registered.add(packageRoot);
}
