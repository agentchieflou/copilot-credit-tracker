import { paths } from './paths.js';
import { readJson, writeJson } from './store.js';

function normalize(s) {
  return String(s).toLowerCase().trim().replace(/[\s_]+/g, '-');
}

/**
 * Bundled table + local overrides. Overrides can adjust a multiplier GitHub has
 * changed, or add a model that only exists in your enterprise deployment,
 * without ever editing files inside the installed package.
 */
export function loadModelTable() {
  const p = paths();
  const bundled = readJson(p.bundledModelsFile, { asOf: 'unknown', plans: {}, models: [] });
  const override = readJson(p.modelsOverrideFile, null);
  if (!override) return { ...bundled, overridden: {} };

  const byId = new Map(bundled.models.map((m) => [m.id, { ...m }]));
  const overridden = {};
  for (const [id, patch] of Object.entries(override.models || {})) {
    const key = normalize(id);
    const existing = byId.get(key);
    const merged = { id: key, label: key, vendor: 'custom', aliases: [], ...existing, ...patch, id: key };
    byId.set(key, merged);
    overridden[key] = patch.multiplier;
  }
  return {
    ...bundled,
    plans: { ...bundled.plans, ...(override.plans || {}) },
    models: [...byId.values()],
    overridden,
    overrideAsOf: override.updatedAt || null,
  };
}

export function saveModelOverride(id, patch) {
  const p = paths();
  const current = readJson(p.modelsOverrideFile, { models: {}, plans: {} });
  const key = normalize(id);
  current.models = current.models || {};
  current.models[key] = { ...(current.models[key] || {}), ...patch };
  current.updatedAt = new Date().toISOString();
  writeJson(p.modelsOverrideFile, current);
  return current.models[key];
}

export function clearModelOverride(id) {
  const p = paths();
  const current = readJson(p.modelsOverrideFile, null);
  if (!current || !current.models) return false;
  const key = normalize(id);
  if (!(key in current.models)) return false;
  delete current.models[key];
  current.updatedAt = new Date().toISOString();
  writeJson(p.modelsOverrideFile, current);
  return true;
}

export class UnknownModelError extends Error {
  constructor(input, candidates) {
    const hint = candidates.length
      ? `Did you mean: ${candidates.join(', ')}?`
      : "Run `ccred models` to list known ids, or register it with `ccred models --set <id>=<multiplier>`.";
    super(`Unknown model "${input}". ${hint}`);
    this.name = 'UnknownModelError';
    this.candidates = candidates;
  }
}

/**
 * Accepts an exact id, a registered alias, or an unambiguous partial match.
 * Returns the model record; throws UnknownModelError with suggestions otherwise.
 */
export function resolveModel(input, table = loadModelTable()) {
  const q = normalize(input);
  const models = table.models;

  const exact = models.find((m) => m.id === q);
  if (exact) return exact;

  const alias = models.find((m) => (m.aliases || []).some((a) => normalize(a) === q));
  if (alias) return alias;

  const partial = models.filter((m) => m.id.includes(q) || normalize(m.label).includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new UnknownModelError(input, partial.map((m) => m.id));

  const fuzzy = models
    .filter((m) => {
      const bare = q.replace(/[^a-z0-9]/g, '');
      return m.id.replace(/[^a-z0-9]/g, '').includes(bare) && bare.length >= 2;
    })
    .map((m) => m.id);
  throw new UnknownModelError(input, fuzzy.slice(0, 5));
}

export function planAllowance(cfg, table = loadModelTable()) {
  if (typeof cfg.allowance === 'number' && cfg.allowance >= 0) return cfg.allowance;
  const plan = table.plans?.[cfg.plan];
  return plan ? plan.allowance : 0;
}

export function planLabel(cfg, table = loadModelTable()) {
  return table.plans?.[cfg.plan]?.label || cfg.plan;
}

/** Credits for one premium request on this model. */
export function requestCredits(model, count = 1) {
  return round4(Number(model.multiplier) * count);
}

export function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
