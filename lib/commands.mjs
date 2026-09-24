import { formatMessage as tr } from '../public/i18n-core.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentEnvironment, discoverCli } from './agent.mjs';
import { HttpError, validateDirectory } from './store.mjs';
import { STUDIO_COMMANDS, COMMAND_ALIASES } from '../public/command-definitions.js';
export { STUDIO_COMMANDS, COMMAND_ALIASES };

export const SESSION_COMMANDS = new Set(['compact', 'refine', 'goal', 'autonomous']);
const descriptions = {
  compact: tr('server.resumer_le_contexte_de_la_session'),
  refine: tr('server.ameliorer_les_instructions_et_ressources_reutilisables'),
  goal: tr('server.definir_ou_gerer_un_objectif_persistant'),
  autonomous: tr('server.afficher_activer_ou_desactiver_le_mode_autonome'),
};
export function parseCommand(text) {
  const match = typeof text === 'string' && text.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  return match
    ? {
        name: Object.hasOwn(COMMAND_ALIASES, match[1]) ? COMMAND_ALIASES[match[1]] : match[1],
        args: (match[2] || '').trim(),
      }
    : null;
}
export function commandCatalog(native) {
  const builtin = native.builtins || [];
  const commands = Object.entries(STUDIO_COMMANDS).map(([name, [description, action, argumentHint]]) => ({
    name,
    description,
    action,
    argumentHint,
    source: 'studio',
    supported: true,
  }));
  for (const command of builtin) {
    if (Object.hasOwn(STUDIO_COMMANDS, command.name)) continue;
    commands.push({
      ...command,
      description: descriptions[command.name] || command.description,
      source: 'native',
      supported: SESSION_COMMANDS.has(command.name),
      ...(SESSION_COMMANDS.has(command.name)
        ? {}
        : { reason: tr('server.cette_commande_necessite_l_interface_terminal_de_prime_agent') }),
    });
  }
  for (const command of native.commands || []) {
    if (commands.some((item) => item.name === command.name)) continue;
    commands.push({
      ...command,
      supported: command.source !== 'extension',
      ...(command.source === 'extension'
        ? { reason: tr('server.les_extensions_interactives_necessitent_le_terminal_prime_agent') }
        : {}),
    });
  }
  return { commands, diagnostics: native.diagnostics || [], live: native.live === true };
}

/** Parse 2+ leading /skill:name tokens sharing one trailing user text. */
export function parseMultiSkillCommand(text) {
  if (typeof text !== 'string') return null;
  const seen = [];
  let count = 0;
  let rest = text.trim();
  while (true) {
    const match = rest.match(/^\/skill:([A-Za-z0-9-]+)(?=\s|$)/);
    if (!match) break;
    count++;
    if (!seen.includes(match[1])) seen.push(match[1]);
    rest = rest.slice(match[0].length).trim();
  }
  return count >= 2 ? { names: seen, args: rest } : null;
}

/** Reject terminal-only/unknown commands before they can become an ordinary model prompt. */
export function validateCommand(text, catalog, { attachments = false } = {}) {
  const multi = parseMultiSkillCommand(text);
  if (multi) {
    for (const name of multi.names) {
      const command = catalog.commands.find((item) => item.name === `skill:${name}`);
      if (!command)
        throw new HttpError(
          400,
          tr('server.skill_inconnu_dans_ce_projet', { value1: name }),
        );
      if (!command.supported) throw new HttpError(400, command.reason);
    }
    return;
  }
  const parsed = parseCommand(text);
  if (!parsed) return;
  const command = catalog.commands.find((item) => item.name === parsed.name);
  if (!command)
    throw new HttpError(
      400,
      tr('server.commande_inconnue_dans_ce_projet_ouvrez_le_menu_pour_choisir_une', { value1: parsed.name }),
    );
  if (!command.supported) throw new HttpError(400, command.reason);
  if (command.source === 'studio')
    throw new HttpError(400, tr('server.cette_commande_s_utilise_depuis_le_menu_du_studio'));
  if (SESSION_COMMANDS.has(command.name)) {
    if (/[\r\n\u2028\u2029]/.test(text.trim()) || attachments)
      throw new HttpError(400, tr('server.une_commande_de_session_s_ecrit_sur_une_seule_ligne_sans_piece_j'));
  }
}

export function createCommandService({ agentHome, getLiveClient } = {}) {
  const workers = new Set();
  const cache = new Map();
  let closed = false;
  function read(cwd) {
    const hit = cache.get(cwd);
    if (hit && hit.expires > Date.now()) return hit.promise;
    if (workers.size >= 3)
      throw new HttpError(429, tr('server.le_catalogue_se_charge_reessayez_dans_un_instant'));
    const cli = discoverCli();
    if (!cli?.packageDir)
      throw new HttpError(503, tr('server.installez_prime_agent_pour_utiliser_ses_commandes_et_skills'));
    const promise = new Promise((resolve, reject) => {
      const child = fork(
        fileURLToPath(new URL('../scripts/command-catalog-worker.mjs', import.meta.url)),
        [],
        {
          cwd,
          env: agentEnvironment({ agentHome }),
          execArgv: [],
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      workers.add(child);
      const timer = setTimeout(
        () => finish(new HttpError(504, tr('server.le_catalogue_prime_agent_met_trop_de_temps_a_repondre'))),
        15000,
      );
      let finished = false;
      function finish(error, result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        workers.delete(child);
        child.kill();
        if (error) {
          cache.delete(cwd);
          reject(error);
        } else resolve(result);
      }
      child.on('error', () =>
        finish(new HttpError(503, tr('server.impossible_de_lire_le_catalogue_prime_agent'))),
      );
      child.on('exit', () =>
        finish(new HttpError(503, tr('server.le_lecteur_du_catalogue_prime_agent_s_est_arrete'))),
      );
      child.on('message', (data) =>
        data?.ok
          ? finish(null, data.catalog)
          : finish(
              new HttpError(503, tr('server.le_catalogue_necessite_une_version_compatible_de_prime_agent')),
            ),
      );
      child.send({ cwd, agentHome, packageDir: cli.packageDir });
    });
    if (cache.size > 24) cache.delete(cache.keys().next().value);
    cache.set(cwd, { promise, expires: Date.now() + 5000 });
    return promise;
  }
  return {
    async list({ cwd, sessionId } = {}) {
      if (closed) throw new HttpError(503, tr('server.le_studio_s_arrete'));
      cwd = await validateDirectory(cwd);
      const native = await read(cwd);
      const client = sessionId && (await getLiveClient?.(sessionId, cwd));
      if (client) {
        try {
          const commands = await client.getCommands(sessionId, cwd);
          return commandCatalog({
            ...native,
            commands: commands.map((c) => ({
              ...native.commands.find(
                (item) => item.name === c.name && item.sourceInfo?.path === c.sourceInfo?.path,
              ),
              ...c,
            })),
            live: true,
          });
        } finally {
          client.close?.();
        }
      }
      return commandCatalog(native);
    },
    close() {
      closed = true;
      for (const child of workers) child.kill();
      cache.clear();
    },
  };
}
