import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const projectKey = (cwd) => (process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd));
export const inheritedPolicy = () => ({ model: '', thinking: '' });
export function validPolicy(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => ['model', 'thinking'].includes(key)) &&
    typeof value.model === 'string' &&
    (value.model === '' || /^[a-z0-9][a-z0-9._-]{0,99}\/[^\s\x00-\x1f\x7f]{1,300}$/u.test(value.model)) &&
    (value.thinking === '' || THINKING_LEVELS.includes(value.thinking))
  );
}
export function readPolicyFile(file) {
  const empty = { version: 1, revision: '', global: inheritedPolicy(), projects: {} };
  if (!file) return empty;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error();
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (
      data.version !== 1 ||
      typeof data.revision !== 'string' ||
      !validPolicy(data.global) ||
      !data.projects ||
      typeof data.projects !== 'object' ||
      Array.isArray(data.projects) ||
      !Object.values(data.projects).every(validPolicy)
    )
      throw new Error();
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return empty;
    throw new Error(
      'Les réglages des sous-agents du Studio sont illisibles. Corrigez la configuration avant de déléguer.',
    );
  }
}
export function policyFor(cwd, file = process.env.PRIME_STUDIO_SUBAGENT_POLICY) {
  const data = readPolicyFile(file);
  return data.projects[projectKey(cwd)] ?? data.global;
}
export function applySubagentDefaults(cwd, kwargs, file) {
  const policy = policyFor(cwd, file);
  return {
    ...(policy.model ? { model: policy.model } : {}),
    ...(policy.thinking ? { thinking: policy.thinking } : {}),
    ...kwargs,
  };
}
export function subagentInstruction(cwd, file) {
  const policy = policyFor(cwd, file);
  if (!policy.model && !policy.thinking) return '';
  return [
    '## Prime Agent Studio — subagent defaults',
    'For delegated agents created with rlm.spawn, use these defaults unless the user requests another choice for the task:',
    `- Model: ${policy.model || 'omit the model argument to use the native default model, otherwise inherit the parent model'}.`,
    `- Thinking level: ${policy.thinking || 'inherit the parent thinking level (native model compatibility rules apply)'}.`,
    'Every rlm.spawn call requires an explicit unique `name` keyword argument.',
    'The Studio supplies these values for omitted model/thinking arguments. Explicit arguments take priority. Do not select another model or thinking level without a task-specific reason. Existing children keep their current settings.',
  ].join('\n');
}
