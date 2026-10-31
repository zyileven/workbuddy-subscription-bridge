export const MODEL_FAMILIES = ['astra', 'sol', 'terra', 'luna'];
const modelPattern = /^gpt-(\d+(?:\.\d+)*)-(astra|sol|terra|luna)$/;

export function upstreamModelId(id) {
  if (typeof id !== 'string' || !id.endsWith('-bridge')) return id;
  const slug = id.slice(0, -'-bridge'.length);
  return modelPattern.test(slug) ? slug : id;
}

export function modelFamily(id) {
  return typeof id === 'string' ? modelPattern.exec(upstreamModelId(id))?.[2] : undefined;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function latestFamilyModels(models) {
  const selected = new Map();
  for (const model of models) {
    const match = typeof model.id === 'string' && modelPattern.exec(model.id);
    if (!match) continue;
    const version = match[1].split('.').map(Number), family = match[2];
    const previous = selected.get(family);
    if (!previous || compareVersions(version, previous.version) > 0) selected.set(family, { family, model, version });
  }
  return MODEL_FAMILIES.flatMap(family => selected.has(family) ? [selected.get(family)] : []);
}

export function modelReasoning(metadata) {
  if (!Array.isArray(metadata?.supported_reasoning_levels)) return null;
  const efforts = metadata.supported_reasoning_levels.map(level => typeof level === 'string' ? level : level?.effort);
  if (efforts.some(effort => typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))) return null;
  const supportedEfforts = [...new Set(efforts)];
  const defaultEffort = metadata.default_reasoning_level;
  if (defaultEffort != null && !supportedEfforts.includes(defaultEffort)) return null;
  return {
    supportedEfforts,
    ...(defaultEffort != null ? { defaultEffort } : {}),
    canDisableThinking: supportedEfforts.includes('none'),
  };
}
