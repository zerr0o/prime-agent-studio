import { formatMessage as tr } from '../public/i18n-core.js';
import { queuedAgentMessage } from '../public/agent-messages.js';
import { createHash } from 'node:crypto';
import { HttpError, cwdKey, validId } from './store.mjs';
import { validateImages } from './images.mjs';
import { validateFiles, appendFileMessage, splitFileMessage } from './files.mjs';
import { parseCommand, parseMultiSkillCommand, SESSION_COMMANDS } from './commands.mjs';
import { expandMultiSkillMessage } from './skill-expansion.mjs';

const lanes = new Set(['steering', 'followUp']);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function messageText(value) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, tr('server.le_message_est_vide'));
  if (Buffer.byteLength(value) > 256 * 1024) throw new HttpError(413, tr('server.le_message_depasse_256_ko'));
  return value;
}

/** Admission and retry protection for an active execution of a native session. */
export function createLiveMessages({ getRuns, getClient, fileStore, validateMessage, getCatalog, now = Date.now }) {
  const requests = new Map();
  async function target(sessionId, cwd, writing = false) {
    if (!validId(sessionId) || typeof cwd !== 'string' || !cwd)
      throw new HttpError(400, tr('server.session_ou_projet_invalide'));
    // Completed runs remain in the server's replay history. They must never
    // shadow a later execution of the same native session.
    const run = (await getRuns()).find(
      (r) =>
        r.sessionId === sessionId &&
        cwdKey(r.cwd) === cwdKey(cwd) &&
        ['running', 'stopping'].includes(r.status),
    );
    if (!run) {
      if (writing)
        throw new HttpError(409, tr('server.cette_execution_est_terminee_votre_brouillon_est_conserve'));
      return null;
    }
    if (writing && run.status !== 'running')
      throw new HttpError(409, tr('server.l_agent_est_en_cours_d_arret'));
    const client = await getClient(run);
    if (!client) {
      if (writing)
        throw new HttpError(503, tr('server.l_envoi_pendant_l_execution_est_momentanement_indisponible'));
      return null;
    }
    return { run, client };
  }
  const unavailable = () => ({ available: false, steering: [], followUps: [] });
  function snapshot(value) {
    return {
      available: value?.available !== false,
      steering: Array.isArray(value?.steering) ? value.steering : [],
      followUps: Array.isArray(value?.followUps) ? value.followUps : [],
    };
  }
  async function getSnapshot(sessionId, cwd) {
    const selected = await target(sessionId, cwd);
    if (!selected) return unavailable();
    try {
      return snapshot(await selected.client.getSnapshot(sessionId, cwd));
    } catch (error) {
      if ([404, 409, 503].includes(error.status)) return unavailable();
      throw error;
    }
  }
  function once(key, value, action) {
    for (const [id, entry] of requests) if (entry.expires <= now()) requests.delete(id);
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const previous = requests.get(key);
    if (previous) {
      if (previous.hash !== hash)
        throw new HttpError(409, tr('server.cet_identifiant_correspond_a_un_autre_envoi'));
      return previous.promise;
    }
    if (requests.size >= 2000)
      throw new HttpError(429, tr('server.trop_de_demandes_reessayez_dans_quelques_instants'));
    // Cache errors too: a timed-out native acceptance must never be blindly resubmitted.
    const promise = Promise.resolve().then(action);
    requests.set(key, { hash, promise, expires: now() + 60 * 60 * 1000 });
    return promise;
  }
  async function send(sessionId, body) {
    if (!object(body)) throw new HttpError(400, tr('server.demande_invalide'));
    const images = validateImages(body.images);
    const files = validateFiles(body.files);
    if (images.length + files.length > 8)
      throw new HttpError(400, tr('server.ajoutez_au_maximum_8_pieces_jointes'));
    const message = messageText(
      (images.length || files.length) && body.message === ''
        ? tr('ui.analyse_les_pieces_jointes')
        : body.message,
    );
    if (!['steer', 'follow_up'].includes(body.mode))
      throw new HttpError(400, tr('server.mode_d_envoi_invalide'));
    if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId))
      throw new HttpError(400, tr('server.identifiant_d_envoi_invalide'));
    if (!validId(sessionId) || typeof body.cwd !== 'string')
      throw new HttpError(400, tr('server.session_invalide'));
    const value = {
      sessionId,
      cwd: cwdKey(body.cwd),
      message,
      mode: body.mode,
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
    };
    return once(`${sessionId}:${body.requestId}`, value, async () => {
      await validateMessage?.(message, {
        sessionId,
        cwd: body.cwd,
        attachments: images.length + files.length > 0,
      });
      let outbound = message;
      if (parseMultiSkillCommand(message) && typeof getCatalog === 'function') {
        const catalog = await getCatalog({ cwd: body.cwd, sessionId });
        outbound = (await expandMultiSkillMessage(message, catalog, { maxChars: 256 * 1024 })) || message;
      }
      const { client } = await target(sessionId, body.cwd, true);
      if (files.length && !fileStore)
        throw new HttpError(503, tr('server.stockage_des_fichiers_indisponible'));
      const nativeMessage = appendFileMessage(outbound, files.length ? await fileStore.save(files) : []);
      const result = await client.send(sessionId, body.cwd, {
        message: nativeMessage,
        mode: body.mode,
        requestId: body.requestId,
        ...(images.length ? { images } : {}),
      });
      if (result?.accepted !== true)
        throw new HttpError(409, tr('server.le_message_n_a_pas_ete_accepte_votre_brouillon_est_conserve'));
      return {
        accepted: true,
        requestId: body.requestId,
        ...(result?.snapshot ? snapshot(result.snapshot) : {}),
      };
    });
  }
  async function mutate(sessionId, body) {
    if (
      !object(body) ||
      !lanes.has(body.lane) ||
      !Number.isSafeInteger(body.index) ||
      body.index < 0 ||
      typeof body.expectedText !== 'string' ||
      !object(body.mutation)
    )
      throw new HttpError(400, tr('server.message_en_attente_invalide'));
    const { mutation } = body;
    if (queuedAgentMessage(body.expectedText)) throw new HttpError(409, tr('agents.message_protected'));
    if (!['delete', 'move', 'replace'].includes(mutation.type))
      throw new HttpError(400, tr('server.modification_invalide'));
    if (mutation.type === 'move' && ![-1, 1].includes(mutation.direction))
      throw new HttpError(400, tr('server.deplacement_invalide'));
    if (mutation.type === 'replace') {
      messageText(mutation.text);
      if (parseCommand(mutation.text)) mutation.text = mutation.text.trim();
      if (
        SESSION_COMMANDS.has(parseCommand(mutation.text)?.name) !==
        SESSION_COMMANDS.has(parseCommand(body.expectedText)?.name)
      )
        throw new HttpError(
          400,
          tr('server.supprimez_puis_renvoyez_ce_message_pour_le_remplacer_par_une_comm'),
        );
      await validateMessage?.(mutation.text, { sessionId, cwd: body.cwd });
      if (!lanes.has(mutation.lane)) throw new HttpError(400, tr('server.mode_d_envoi_invalide'));
      const original = splitFileMessage(body.expectedText);
      if (original.attachments.length && !splitFileMessage(mutation.text).attachments.length)
        mutation.text += body.expectedText.slice(original.text.length);
    }
    const { client } = await target(sessionId, body.cwd, true);
    const result = await client.mutate(sessionId, body.cwd, {
      lane: body.lane,
      index: body.index,
      expectedText: body.expectedText,
      mutation,
    });
    if (result?.status && result.status !== 'applied')
      throw new HttpError(409, tr('server.la_file_a_change_ou_ce_message_a_deja_ete_transmis_actualisez_la'));
    return { status: 'applied', ...snapshot(result?.snapshot || result) };
  }
  return { getSnapshot, send, mutate };
}

export async function routeLiveMessages({ service, method, url, readBody }) {
  if (url.pathname === '/api/live/capabilities' && method === 'GET') return { available: true };
  const match = url.pathname.match(/^\/api\/live\/sessions\/([A-Za-z0-9_-]+)(?:\/(messages|queue))?$/);
  if (!match) throw new HttpError(404, tr('server.route_introuvable'));
  if (method === 'GET' && !match[2]) return service.getSnapshot(match[1], url.searchParams.get('cwd'));
  if (method === 'POST' && match[2] === 'messages') return service.send(match[1], await readBody());
  if (method === 'POST' && match[2] === 'queue') return service.mutate(match[1], await readBody());
  throw new HttpError(405, tr('server.methode_non_autorisee'));
}
