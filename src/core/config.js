import { paths } from './paths.js';
import { readJson, writeJson } from './store.js';

export const CONFIG_VERSION = 1;

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    /** Copilot plan id from the model table's `plans` map. Drives the default allowance. */
    plan: 'pro',
    /** Explicit monthly premium-request allowance. null = derive from `plan`. */
    allowance: null,
    /**
     * Day of month the Copilot allowance resets. Personal plans usually reset on
     * your subscription renewal day, not the 1st. 31 is clamped to the last day
     * of shorter months.
     */
    cycleResetDay: 1,
    /** Track requests on 0x models too. They cost nothing but reveal a lot about habits. */
    countFreeModels: true,
    session: {
      /**
       * A new prompt logged this many minutes after the previous one starts a
       * fresh session instead of extending the open one. Stops an abandoned
       * `ccred start` from swallowing tomorrow's work.
       */
      idleCloseMinutes: 45,
    },
    github: {
      /** https://api.github.com, or https://<ghes-host>/api/v3 for GitHub Enterprise Server. */
      apiBase: 'https://api.github.com',
      /** personal | organization | enterprise */
      scope: 'personal',
      username: null,
      org: null,
      enterprise: null,
    },
    /**
     * Optional credits-per-1000-tokens rates. GitHub bills per premium request,
     * not per token, so these default to 0 and token counts stay informational.
     * Enterprise agreements that bill on tokens can set real rates here and the
     * report will price input / output / context separately.
     */
    tokenRates: {
      default: { input: 0, output: 0, context: 0 },
      perModel: {},
    },
    display: {
      /** auto | always | never */
      color: 'auto',
      width: 76,
    },
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  const stored = readJson(paths().configFile, null);
  return stored ? deepMerge(defaultConfig(), stored) : defaultConfig();
}

export function saveConfig(cfg) {
  writeJson(paths().configFile, cfg);
  return cfg;
}

export function configExists() {
  return readJson(paths().configFile, null) !== null;
}

export function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[last] = value;
  return obj;
}

/** Coerce CLI strings into the type the existing config value implies. */
export function coerceValue(raw, previous) {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (typeof previous === 'number' || /^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

export function flattenConfig(obj, prefix = '') {
  const rows = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) rows.push(...flattenConfig(v, key));
    else rows.push([key, v]);
  }
  return rows;
}
