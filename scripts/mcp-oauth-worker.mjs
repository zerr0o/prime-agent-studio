// Own process so cancellation also closes the native OAuth callback server.
import { createInterface } from 'node:readline';
import { createMcpConfigStore, mcpRevision } from '../lib/mcp-config.mjs';
import { oauthErrorMessage } from '../lib/mcp-oauth-errors.mjs';

const send = (data) => process.stdout.write(JSON.stringify(data) + '\n');
let manualResolve,
  manualReject,
  started = false;
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (!started) {
    started = true;
    void login(message);
  } else if (message.type === 'complete') manualResolve?.(message.url);
  else if (message.type === 'cancel') manualReject?.(new Error('Cancelled'));
});
async function login({ agentHome, name, revision }) {
  try {
    const store = createMcpConfigStore({ agentHome }),
      selected = await store.get(name);
    if (mcpRevision(selected.config) !== revision) throw new Error('Configuration changed');
    const { config, builtin, loaded } = selected;
    if (!config.oauth || config.enabled === false) throw new Error('OAuth unavailable');
    const provider = loaded.createMcpOAuthProvider({
      server: name,
      label: builtin?.label || name,
      url: config.url,
      scopes: builtin?.oauth?.scopes,
      clientId: builtin?.oauth?.clientId,
    });
    const credentials = await provider.login({
      onAuth: ({ url }) => send({ status: 'waiting', url }),
      onProgress: () => {},
      onManualCodeInput: () =>
        new Promise((resolve, reject) => {
          manualResolve = resolve;
          manualReject = reject;
        }),
      onPrompt: () =>
        new Promise((resolve, reject) => {
          manualResolve = resolve;
          manualReject = reject;
        }),
    });
    await store.saveCredential(name, revision, credentials);
    send({ status: 'complete' });
  } catch (error) {
    // Surface the real provider error (endpoint, HTTP status, reason) instead
    // of a generic sentence. Details are sanitized: no code, state or secret.
    send({ status: 'error', error: oauthErrorMessage(error) });
  } finally {
    input.close();
    process.stdin.destroy();
  }
}
