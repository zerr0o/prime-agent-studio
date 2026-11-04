const statuses = new Set(['active', 'paused', 'budget_limited', 'complete', 'error']);

/** Project only the native goal fields used by Studio, never arbitrary custom-entry data. */
export function publicGoal(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !statuses.has(value.status) ||
    typeof value.goalId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(value.goalId) ||
    typeof value.objective !== 'string' ||
    !value.objective.trim() ||
    [...value.objective].length > 4000
  )
    return null;
  const goal = {
    goalId: value.goalId,
    objective: value.objective,
    status: value.status,
    active: value.status === 'active',
  };
  for (const key of ['tokensUsed', 'timeUsedSeconds', 'continuationsUsed']) {
    if (!Number.isFinite(value[key]) || value[key] < 0) return null;
    goal[key] = Math.trunc(value[key]);
  }
  for (const key of ['tokenBudget', 'createdAt', 'updatedAt']) {
    if (Number.isSafeInteger(value[key]) && value[key] > 0) goal[key] = value[key];
  }
  return goal;
}

/** Explicit resume is only available while the original budget remains. */
export function canResumeGoal(value) {
  const goal = publicGoal(value);
  return (
    !!goal &&
    ['error', 'paused', 'budget_limited'].includes(goal.status) &&
    Number.isSafeInteger(value.tokensUsed) &&
    value.tokensUsed >= 0 &&
    (value.tokenBudget == null ||
      (Number.isSafeInteger(value.tokenBudget) &&
        value.tokenBudget > 0 &&
        value.tokensUsed < value.tokenBudget))
  );
}

export function branchGoal(branch) {
  return publicGoal(
    branch.findLast((entry) => entry.type === 'custom' && entry.customType === 'thread_goal_state')?.data,
  );
}
