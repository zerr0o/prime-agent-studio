
// Native runtime extension: registers the gated Muse Code subscription
// provider in every Studio-launched agent process (main runs and RLM
// children inherit it). Loaded through Prime Agent native --extension
// option. The OAuth adapter is owned by lib/muse-oauth-provider.mjs; when
// that module is missing or invalid this extension does nothing, so no
// nonfunctional stub ever becomes visible. User models.json muse-code
// entries win: the extension skips registration when one exists.
import { join } from 'node:path';
import { MUSE_CODE_PROVIDER_ID, hasUserMuseCodeConfig, loadMuseCodeConfig } from '../lib/muse-code-gate.mjs';

export default async function studioMuseCodeProvider(pi) {
  try {
    if (!pi || typeof pi.registerProvider !== 'function') return;
    const agentHome = process.env.PRIME_AGENT_CODING_AGENT_DIR || '';
    if (hasUserMuseCodeConfig(join(agentHome, 'models.json'))) return;
    const loaded = await loadMuseCodeConfig(() => import('../lib/muse-oauth-provider.mjs'));
    if (!loaded) return;
    pi.registerProvider(MUSE_CODE_PROVIDER_ID, loaded.config);
  } catch {
    // A failed registration must never break session startup.
  }
}
