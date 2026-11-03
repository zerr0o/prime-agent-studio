import { register } from 'node:module';
import { realpathSync } from 'node:fs';
const packageRoot = process.env.PRIME_STUDIO_SESSION_PACKAGE;
if (packageRoot) {
  const data = { packageRoot: realpathSync(packageRoot) };
  register('./session-preferences.mjs', import.meta.url, { data });
  // Same native AgentSession scope, inherited by both RPC and print workers.
  register('./session-quiescence.mjs', import.meta.url, { data });
  // Per-conversation shared memories (default off). Same scope.
  register('./shared-memories.mjs', import.meta.url, { data });
}
