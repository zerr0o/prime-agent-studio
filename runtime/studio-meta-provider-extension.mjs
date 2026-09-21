// Native runtime extension: registers the Meta Model API provider in every
// Studio-launched agent process (main runs and RLM children inherit it).
// Loaded through Prime Agent native --extension option. User models.json
// overrides win: when the user defined a meta provider entry, this skips
// registration so custom baseUrl, apiKey and models are preserved.
import { join } from 'node:path';
import { META_PROVIDER_ID, hasUserMetaConfig, metaProviderConfig } from '../lib/meta-provider.mjs';

export default function studioMetaProvider(pi) {
  // Shared JSONC-aware check: ANY user providers.meta entry (including empty
  // or baseUrl-only, comments allowed) wins. Malformed content fails closed.
  if (hasUserMetaConfig(join(process.env.PRIME_AGENT_CODING_AGENT_DIR || '', 'models.json'))) return;
  try {
    pi.registerProvider(META_PROVIDER_ID, metaProviderConfig());
  } catch {
    // A failed registration must never break session startup.
  }
}
