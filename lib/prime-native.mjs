import { formatMessage as tr } from '../public/i18n-core.js';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { discoverCli } from './agent.mjs';
import { HttpError } from './store.mjs';
let pending;
export function loadPrimeNative() {
  return (pending ||= (async () => {
    const cli = discoverCli();
    if (!cli?.packageDir) throw new HttpError(503, tr('server.installez_prime_agent_pour_gerer_les_mcp'));
    const localImport = (path) => import(pathToFileURL(join(cli.packageDir, path)).href);
    const optionalImport = (path) => localImport(path).catch(() => ({}));
    const [settings, auth, mcp, oauth, serviceCatalog] = await Promise.all([
      localImport('dist/core/settings-manager.js'),
      localImport('dist/core/auth-storage.js'),
      localImport('node_modules/@earendil-works/pi-ai/dist/mcp.js'),
      localImport('node_modules/@earendil-works/pi-ai/dist/oauth.js'),
      optionalImport('dist/core/mcp/service-catalog.js'),
    ]);
    return { ...settings, ...auth, ...mcp, ...oauth, ...serviceCatalog, cli };
  })().catch(() => {
    pending = undefined;
    throw new HttpError(503, tr('server.la_gestion_mcp_necessite_une_version_compatible_de_prime_agent'));
  }));
}
