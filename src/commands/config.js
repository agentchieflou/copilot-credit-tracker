import fs from 'node:fs';
import { loadConfig, saveConfig, defaultConfig, getPath, setPath, coerceValue, flattenConfig } from '../core/config.js';
import { paths } from '../core/paths.js';
import { loadModelTable, planAllowance } from '../core/models.js';
import { loadState } from '../core/state.js';
import { c, fmtNum, table, heading, kv, fmtDate } from '../util/fmt.js';
import { asNumber, asString } from '../util/args.js';

const KNOWN_SCOPES = ['personal', 'organization', 'enterprise'];

export function cmdConfig(flags, positionals, { json }) {
  const [action = 'list', key, ...rest] = positionals;
  const cfg = loadConfig();
  const p = paths();

  if (action === 'path' || action === 'where') {
    if (json) return { ...p, archiveFile: undefined };
    console.log(heading('Storage'));
    console.log(kv('data dir', p.home));
    console.log(kv('config', p.configFile));
    console.log(kv('live cycle', p.currentFile));
    console.log(kv('archives', p.archiveDir));
    console.log(kv('model overrides', p.modelsOverrideFile));
    console.log('');
    console.log(c.dim('  Set CCRED_HOME to point at a different profile (e.g. work vs personal).'));
    console.log('');
    return null;
  }

  if (action === 'get') {
    if (!key) throw new Error('Usage: ccred config get <key>');
    const value = getPath(cfg, key);
    if (json) return { key, value };
    console.log(value === undefined ? c.dim('(unset)') : String(value));
    return null;
  }

  if (action === 'set') {
    if (!key || rest.length === 0) throw new Error('Usage: ccred config set <key> <value>');
    const raw = rest.join(' ');
    const previous = getPath(cfg, key);
    const value = coerceValue(raw, previous);
    validate(key, value);
    setPath(cfg, key, value);
    saveConfig(cfg);
    if (json) return { key, previous, value };
    console.log(`${c.green('set')} ${key} = ${c.bold(String(value))} ${c.dim(previous === undefined ? '' : `(was ${previous})`)}`);
    if (key === 'cycleResetDay' || key === 'plan' || key === 'allowance') {
      const state = loadState();
      console.log(
        c.dim(
          `  live cycle is now ${state.period.id}: ${fmtDate(state.period.start)} - ${fmtDate(
            state.period.end,
          )}, ${fmtNum(state.period.allowance)} credits`,
        ),
      );
    }
    return null;
  }

  if (action === 'reset') {
    const fresh = defaultConfig();
    saveConfig(fresh);
    if (json) return fresh;
    console.log(c.yellow('config reset to defaults (ledger and archives untouched)'));
    return null;
  }

  if (action === 'edit') {
    if (json) return { file: p.configFile };
    if (!fs.existsSync(p.configFile)) saveConfig(cfg);
    console.log(p.configFile);
    return null;
  }

  // default: list
  const t = loadModelTable();
  if (json) return { ...cfg, resolvedAllowance: planAllowance(cfg, t), dataDir: p.home };

  console.log(heading('Config'));
  console.log(
    table(
      flattenConfig(cfg).map(([k, v]) => [k, v === null ? c.dim('null') : String(v)]),
      { align: ['left', 'left'] },
    ),
  );
  console.log('');
  console.log(kv('resolved allowance', `${fmtNum(planAllowance(cfg, t))} credits/cycle`));
  console.log(kv('data dir', c.dim(p.home)));
  console.log('');
  console.log(c.dim('  ccred config set plan pro+'));
  console.log(c.dim('  ccred config set cycleResetDay 14'));
  console.log(c.dim('  ccred config set github.scope enterprise'));
  console.log('');
  return null;
}

function validate(key, value) {
  if (key === 'cycleResetDay') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error('cycleResetDay must be an integer 1-31.');
  }
  if (key === 'github.scope' && !KNOWN_SCOPES.includes(value)) {
    throw new Error(`github.scope must be one of: ${KNOWN_SCOPES.join(', ')}`);
  }
  if (key === 'plan') {
    const t = loadModelTable();
    if (!t.plans[value]) throw new Error(`Unknown plan "${value}". Known: ${Object.keys(t.plans).join(', ')}`);
  }
  if (key === 'allowance' && value !== null && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
    throw new Error('allowance must be a non-negative number, or null to derive it from the plan.');
  }
}

export async function cmdInit(flags, positionals, { json }) {
  const cfg = loadConfig();
  const t = loadModelTable();

  const plan = asString(flags.plan, null);
  if (plan) {
    if (!t.plans[plan]) throw new Error(`Unknown plan "${plan}". Known: ${Object.keys(t.plans).join(', ')}`);
    cfg.plan = plan;
  }
  const resetDay = asNumber(flags['reset-day'] ?? flags.resetDay, null);
  if (resetDay != null) {
    if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) {
      throw new Error('--reset-day must be an integer 1-31 (your Copilot renewal day).');
    }
    cfg.cycleResetDay = resetDay;
  }
  const allowance = asNumber(flags.allowance, null);
  if (allowance != null) cfg.allowance = allowance;

  const scope = asString(flags.scope, null);
  if (scope) {
    if (!KNOWN_SCOPES.includes(scope)) throw new Error(`--scope must be one of: ${KNOWN_SCOPES.join(', ')}`);
    cfg.github.scope = scope;
  }
  const user = asString(flags.user ?? flags.username, null);
  if (user) cfg.github.username = user;
  const org = asString(flags.org, null);
  if (org) {
    cfg.github.org = org;
    if (!scope) cfg.github.scope = 'organization';
  }
  const enterprise = asString(flags.enterprise, null);
  if (enterprise) {
    cfg.github.enterprise = enterprise;
    if (!scope) cfg.github.scope = 'enterprise';
  }
  const api = asString(flags.api ?? flags['api-base'], null);
  if (api) cfg.github.apiBase = api.replace(/\/+$/, '');

  saveConfig(cfg);
  const state = loadState();

  // Setting up on the 20th should not mean starting from zero: --import pulls
  // the cycle so far in, so the first `ccred status` shows the real number.
  const wantsImport = flags.import === true || asString(flags.file ?? flags.from, null) !== null;
  const runImport = async () => {
    const { cmdImport } = await import('./import.js');
    return cmdImport(flags, [], { json });
  };

  if (json) {
    return { config: cfg, period: state.period, imported: wantsImport ? await runImport() : null };
  }

  console.log(heading('Ready'));
  console.log(kv('plan', `${t.plans[cfg.plan]?.label || cfg.plan} - ${fmtNum(planAllowance(cfg, t))} credits/cycle`));
  console.log(kv('cycle', `resets on day ${cfg.cycleResetDay}: ${fmtDate(state.period.start)} - ${fmtDate(state.period.end)}`));
  console.log(kv('github scope', cfg.github.scope + (cfg.github.org ? ` (${cfg.github.org})` : cfg.github.enterprise ? ` (${cfg.github.enterprise})` : '')));
  console.log(kv('data dir', c.dim(paths().home)));
  console.log('');

  if (wantsImport) {
    await runImport();
  } else {
    console.log(c.dim('  Already spent part of this cycle? Pull it in rather than starting from zero:'));
    console.log(c.dim('    ccred import                    from GitHub billing usage'));
    console.log(c.dim('    ccred import --file usage.csv   from an exported usage report'));
    console.log('');
  }

  console.log(c.dim('  ccred log sonnet "first prompt of the day"'));
  console.log(c.dim('  ccred status'));
  console.log('');
  return null;
}
