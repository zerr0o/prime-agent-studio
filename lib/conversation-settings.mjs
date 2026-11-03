import { formatMessage as tr } from '../public/i18n-core.js';
import { HttpError, cwdKey } from './store.mjs';

export const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export function validateConversationSettings(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.keys(value).length ||
    Object.keys(value).some((key) => !['model', 'thinking', 'allowQuestions', 'sharedMemories'].includes(key))
  )
    throw new HttpError(400, tr('server.demande_invalide'));
  if (
    'model' in value &&
    (typeof value.model !== 'string' || value.model.length > 300 || /[\x00-\x1f]/.test(value.model))
  )
    throw new HttpError(400, tr('server.modele_invalide'));
  if ('thinking' in value && value.thinking !== '' && !thinkingLevels.has(value.thinking))
    throw new HttpError(400, tr('server.niveau_de_reflexion_invalide'));
  if ('allowQuestions' in value && typeof value.allowQuestions !== 'boolean')
    throw new HttpError(400, tr('server.demande_invalide'));
  if ('sharedMemories' in value && typeof value.sharedMemories !== 'boolean')
    throw new HttpError(400, tr('server.demande_invalide'));
  return { ...value };
}

export function createConversationSettings({ store, getRuns, getClient, getModels }) {
  const pending = new Set();
  return {
    busy: (id) => pending.has(id),
    async update({ id, cwd, settings }) {
      const patch = validateConversationSettings(settings);
      if (pending.has(id)) throw new HttpError(409, tr('server.cette_session_travaille_deja'));
      pending.add(id);
      try {
        // Wait for any in-flight binding write so a slow initial set(true)
        // cannot silently revert a later opt-out(false).
        await store.flushConversationSettings?.().catch(() => {});
        const history = await store.history(id);
        if (typeof cwd !== 'string' || cwdKey(cwd) !== cwdKey(history.cwd))
          throw new HttpError(409, tr('server.cette_session_appartient_a_un_autre_dossier'));
        const run = getRuns().find((r) => r.sessionId === id && ['running', 'stopping'].includes(r.status));
        if (
          run &&
          (run.status === 'stopping' ||
            'model' in patch ||
            'allowQuestions' in patch ||
            'sharedMemories' in patch)
        )
          throw new HttpError(409, tr('server.cette_session_travaille_deja'));
        const catalog = await getModels();
        if (patch.model && catalog.models?.find((m) => m.id === patch.model)?.availability === 'unavailable')
          throw new HttpError(409, tr('model.unavailableSelection'));
        if (run) {
          const client = getClient();
          if (!client?.setThinking) throw new HttpError(503, tr('conversation.liveUnavailable'));
          const level = patch.thinking || catalog.default?.thinking || 'medium';
          // The native response reports the effective level after model clamping.
          try {
            patch.thinking = await client.setThinking(id, cwd, level);
          } catch (error) {
            if (error.code === 'delivery_uncertain') throw new HttpError(503, tr('conversation.unconfirmed'));
            throw error;
          }
          run.thinking = patch.thinking;
        }
        const result = await store.setConversationSettings(id, patch);
        return { ...result, appliedToRun: !!run };
      } finally {
        pending.delete(id);
      }
    },
  };
}
