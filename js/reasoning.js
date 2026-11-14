const LEVELS = ['normal', 'deep', 'max'];

function effortsFor(model) {
  if (model?.api === 'anthropic') return [false, true];
  if (model?.api === 'responses') return model.effort || [];
  if (model?.api === 'chat') return ['low', 'high'];
  if (!model?.reasoning) return [];

  const supported = model.reasoningEfforts;
  if (supported === null) return ['low', 'high', 'max'];
  if (!Array.isArray(supported)) return ['low', 'high'];
  const normal = ['low', 'minimal', 'medium', 'high', 'xhigh', 'max'].find((effort) => supported.includes(effort));
  const deep = ['high', 'medium'].find((effort) => effort !== normal && supported.includes(effort));
  const max = ['max', 'xhigh'].find((effort) => effort !== normal && supported.includes(effort));
  return [normal, deep, max];
}

export function reasoningLevels(model) {
  const efforts = effortsFor(model);
  return LEVELS.filter((level, index) => level === 'normal' || efforts[index] != null);
}

export function resolveReasoningLevel(model, requested, legacyDeep = false) {
  const levels = reasoningLevels(model);
  if (LEVELS.includes(requested)) {
    if (levels.includes(requested)) return requested;
    return requested === 'max' && levels.includes('deep') ? 'deep' : 'normal';
  }
  return legacyDeep ? (levels[1] || 'normal') : 'normal';
}

export function reasoningEffort(model, requested, legacyDeep) {
  return effortsFor(model)[LEVELS.indexOf(resolveReasoningLevel(model, requested, legacyDeep))];
}
