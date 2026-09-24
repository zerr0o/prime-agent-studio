// OAuth refresh and discovery share one bounded, independently owned process tree.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMcpOAuthProvider, createMcpConfigStore, mcpRevision } from '../lib/mcp-config.mjs';
try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { agentHome, name, revision, python } = JSON.parse(input);
  const store = createMcpConfigStore({ agentHome });
  const { config, builtin, loaded } = await store.get(name);
  if (mcpRevision(config) !== revision || config.enabled === false) throw new Error();
  if (config.oauth) {
    loaded.registerOAuthProvider(
      buildMcpOAuthProvider(loaded, {
        name,
        label: builtin?.label || name,
        url: config.url,
        builtin,
        config,
      }),
    );
    const auth = loaded.AuthStorage.create(join(agentHome, 'auth.json'));
    if (auth.get(`mcp:${name}`)?.endpoint !== config.url || !(await auth.getApiKey(`mcp:${name}`)))
      throw new Error();
  }
  if (mcpRevision((await store.get(name)).config) !== revision) throw new Error();
  const child = spawn(python, [fileURLToPath(new URL('./mcp-probe.py', import.meta.url))], {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'inherit', 'ignore'],
  });
  child.stdin.on('error', () => {});
  child.stdin.end(
    JSON.stringify({
      name,
      config: { ...config, startupTimeoutMs: Math.min(config.startupTimeoutMs || 20000, 25000) },
    }),
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
} catch {
  process.stdout.write(JSON.stringify({ error: 'Connexion MCP impossible.' }));
  process.exitCode = 1;
}
