import { formatMessage as tr } from '../public/i18n-core.js';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './store.mjs';
import { loadPrimeNative } from './prime-native.mjs';

// Native Prime Agent 0.9.5 contracts (dist/core/settings-manager.js, dist/core/autonomous.js).
// auxiliaryModel: string selector "provider/id", unset falls back to the session model.
// providerBackupModel: "provider/model-id" or bare id, default none (no silent switch).
// subagentDefaultModel: applied when rlm.spawn does not pin a model, unset inherits parent.
// autonomous: per-field positive number or "unlimited"; invalid entries are dropped natively,
// deletion reverts to built-in defaults. Explicit CLI/slash flags keep winning per run.
export const DEFAULT_AUTONOMOUS_LIMITS = {
  maxContinuations: 3,
  maxTurns: 12,
  maxTokens: 80000,
  timeoutMs: 30 * 60 * 1000,
};
export const AUTONOMOUS_FIELDS = ['maxContinuations', 'maxTurns', 'maxTokens', 'timeoutMs'];
export const ENGINE_SETTINGS_KEYS = [
  'auxiliaryModel',
  'providerBackupModel',
  'nativeSubagentDefaultModel',
  'autonomous',
  'revision',
];

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MODEL_ID = /^[^\s\x00-\x1f\x7f]{1,300}$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

function revisionOf(raw) {
  if (!raw) return null;
  return createHash('sha256').update(raw).digest('hex');
}

// Pure CAS guard, evaluated against the raw content read INSIDE the native
// lock. Exported for unit tests; saveSettings always applies it under lock.
export function assertEngineRevision(raw, expectedRevision) {
  if (expectedRevision === undefined) return revisionOf(raw || '');
  const lockedRevision = revisionOf(raw || '');
  if (lockedRevision !== expectedRevision) {
    const error = new HttpError(
      409,
      tr('server.ces_reglages_ont_change_dans_une_autre_fenetre_rechargez_les_ava'),
    );
    error.currentRevision = lockedRevision;
    throw error;
  }
  return lockedRevision;
}

export function cleanModelReference(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new HttpError(400, tr('server.selection_de_modele_invalide'));
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 500) throw new HttpError(400, tr('server.selection_de_modele_invalide'));
  const slash = trimmed.indexOf('/');
  if (slash < 0) {
    if (!MODEL_ID.test(trimmed) || FORBIDDEN_KEYS.has(trimmed))
      throw new HttpError(400, tr('server.selection_de_modele_invalide'));
    return trimmed;
  }
  const provider = trimmed.slice(0, slash).trim();
  const id = trimmed.slice(slash + 1).trim();
  if (!provider || !id) throw new HttpError(400, tr('server.selection_de_modele_invalide'));
  // Only the first slash separates provider from id; extra slashes belong to the id.
  // Re-validate the remainder as a whole model id (may itself contain slashes).
  if (!PROVIDER_ID.test(provider) || FORBIDDEN_KEYS.has(provider) || !MODEL_ID.test(id))
    throw new HttpError(400, tr('server.selection_de_modele_invalide'));
  return `${provider}/${id}`;
}

export function cleanAutonomousValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value === 'unlimited') return 'unlimited';
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed === 'unlimited') return 'unlimited';
    if (!/^\d+$/.test(trimmed)) throw new HttpError(400, tr('server.budget_autonome_invalide'));
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
      throw new HttpError(400, tr('server.budget_autonome_invalide'));
    return parsed;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HttpError(400, tr('server.budget_autonome_invalide'));
    const truncated = Math.trunc(value);
    if (truncated < 1 || !Number.isSafeInteger(truncated))
      throw new HttpError(400, tr('server.budget_autonome_invalide'));
    return truncated;
  }
  throw new HttpError(400, tr('server.budget_autonome_invalide'));
}

export function cleanAutonomousInput(input) {
  if (input === null) return null;
  if (input === undefined) return undefined;
  if (!record(input)) throw new HttpError(400, tr('server.budget_autonome_invalide'));
  const keys = Object.keys(input);
  if (keys.some((key) => !AUTONOMOUS_FIELDS.includes(key) || FORBIDDEN_KEYS.has(key)))
    throw new HttpError(400, tr('server.budget_autonome_invalide'));
  const cleaned = {};
  for (const field of AUTONOMOUS_FIELDS) {
    if (!(field in input)) continue;
    const value = cleanAutonomousValue(input[field]);
    // null marks deletion of that single budget; omitted fields stay unchanged.
    cleaned[field] = value;
  }
  return cleaned;
}

function storedModelField(settings, key) {
  const value = settings[key];
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
}

function storedAutonomousField(settings, field) {
  const container = record(settings.autonomous) ? settings.autonomous : null;
  const value = container?.[field];
  if (value === 'unlimited') return 'unlimited';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    return truncated > 0 ? truncated : null;
  }
  return null;
}

export function createEngineSettingsStore({ agentHome } = {}) {
  if (!agentHome) throw new TypeError('agentHome est requis.');
  const file = join(agentHome, 'settings.json'),
    backupFile = join(agentHome, 'settings.json.prime-studio.bak');
  let writes = Promise.resolve();

  function readRaw() {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES)
        throw new HttpError(500, tr('server.le_fichier_settings_json_est_inaccessible_ou_trop_volumineux'));
      const raw = readFileSync(file, 'utf8');
      const value = JSON.parse(raw);
      if (!record(value)) throw new Error();
      return { raw, settings: value };
    } catch (error) {
      if (error.code === 'ENOENT') return { raw: '', settings: {} };
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, tr('server.le_fichier_settings_json_contient_un_json_invalide_corrigez_le_a'));
    }
  }

  async function get() {
    await writes.catch(() => {});
    const { raw, settings } = readRaw();
    const autonomous = {};
    for (const field of AUTONOMOUS_FIELDS) autonomous[field] = storedAutonomousField(settings, field);
    return {
      revision: revisionOf(raw),
      auxiliaryModel: storedModelField(settings, 'auxiliaryModel'),
      providerBackupModel: storedModelField(settings, 'providerBackupModel'),
      // Distinct Studio name for the native field; never overwrites the Studio
      // subagent policy file (.local/subagent-defaults.json).
      nativeSubagentDefaultModel: storedModelField(settings, 'subagentDefaultModel'),
      autonomous,
      defaults: { autonomous: { ...DEFAULT_AUTONOMOUS_LIMITS } },
    };
  }

  // Security preflight: same file guards as reads (normal file, no symlink,
  // size cap, valid JSON). Advisory only — never used for CAS. The
  // authoritative re-validation runs inside the native lock below.
  function preflightFile() {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES)
        throw new HttpError(500, tr('server.le_fichier_settings_json_est_inaccessible_ou_trop_volumineux'));
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (!record(value)) throw new Error();
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, tr('server.le_fichier_settings_json_contient_un_json_invalide_corrigez_le_a'));
    }
  }

  async function saveSettings(operation, expectedRevision) {
    const { FileSettingsStorage } = await loadPrimeNative();
    preflightFile();
    // The native writer invokes fn(undefined) before creating agentHome on
    // first write: ensure the directory exists without creating a placeholder
    // settings file (a missing file must keep the null revision).
    mkdirSync(agentHome, { recursive: true, mode: 0o700 });
    // The revision check runs INSIDE the native lock against the locked raw
    // content: a concurrent native or inter-process writer cannot slip between
    // check and write. Same-process callers are already serialized by the
    // writes chain; the lock covers every other writer.
    try {
      new FileSettingsStorage(agentHome, agentHome).withLock('global', (raw) => {
        assertEngineRevision(raw, expectedRevision);
        let settings;
        try {
          settings = raw ? JSON.parse(raw) : {};
        } catch {
          throw new HttpError(500, tr('server.le_fichier_settings_json_contient_un_json_invalide'));
        }
        if (!record(settings))
          throw new HttpError(500, tr('server.le_fichier_settings_json_contient_un_json_invalide'));
        operation(settings);
        // No backup when there was no previous file: on first write the
        // native callback may run unlocked once, then replay under lock on
        // race. Skipping the backup then keeps the callback side-effect free.
        if (raw !== undefined) {
          let backup;
          try {
            backup = lstatSync(backupFile);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          if (backup && (!backup.isFile() || backup.isSymbolicLink()))
            throw new HttpError(500, tr('server.la_sauvegarde_settings_json_doit_etre_un_fichier_normal'));
          writeFileSync(backupFile, raw || '{}\n', { encoding: 'utf8', mode: 0o600 });
          chmodSync(backupFile, 0o600);
        }
        return JSON.stringify(settings, null, 2) + '\n';
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, tr('server.impossible_d_enregistrer_settings_json_la_configuration_preceden'));
    }
  }

  function mutate(operation, expectedRevision) {
    const job = writes.catch(() => {}).then(() => saveSettings(operation, expectedRevision));
    writes = job;
    return job;
  }

  async function set(body = {}) {
    if (!record(body) || Object.keys(body).some((key) => !ENGINE_SETTINGS_KEYS.includes(key)))
      throw new HttpError(400, tr('server.reglages_moteur_invalides'));
    const { revision, auxiliaryModel, providerBackupModel, nativeSubagentDefaultModel, autonomous } = body;
    if (
      revision !== undefined &&
      revision !== null &&
      (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
    )
      throw new HttpError(400, tr('server.reglages_moteur_invalides'));
    const cleanedAuxiliary = auxiliaryModel === undefined ? undefined : cleanModelReference(auxiliaryModel);
    const cleanedBackup =
      providerBackupModel === undefined ? undefined : cleanModelReference(providerBackupModel);
    const cleanedNativeSubagent =
      nativeSubagentDefaultModel === undefined ? undefined : cleanModelReference(nativeSubagentDefaultModel);
    const cleanedAutonomous = cleanAutonomousInput(autonomous);
    await mutate((settings) => {
      if (cleanedAuxiliary !== undefined) {
        if (!cleanedAuxiliary) delete settings.auxiliaryModel;
        else settings.auxiliaryModel = cleanedAuxiliary;
      }
      if (cleanedBackup !== undefined) {
        if (!cleanedBackup) delete settings.providerBackupModel;
        else settings.providerBackupModel = cleanedBackup;
      }
      if (cleanedNativeSubagent !== undefined) {
        if (!cleanedNativeSubagent) delete settings.subagentDefaultModel;
        else settings.subagentDefaultModel = cleanedNativeSubagent;
      }
      if (cleanedAutonomous === null) {
        delete settings.autonomous;
      } else if (cleanedAutonomous !== undefined) {
        const next = record(settings.autonomous) ? { ...settings.autonomous } : {};
        for (const [field, value] of Object.entries(cleanedAutonomous)) {
          if (value === null) delete next[field];
          else next[field] = value;
        }
        // Drop malformed hand edits instead of persisting them; native drops them too.
        for (const field of AUTONOMOUS_FIELDS) {
          const value = next[field];
          if (value === undefined) continue;
          if (value !== 'unlimited' && !(typeof value === 'number' && Number.isFinite(value)))
            delete next[field];
        }
        if (Object.keys(next).length) settings.autonomous = next;
        else delete settings.autonomous;
      }
    }, revision);
    return get();
  }

  return { file, backupFile, get, set };
}
