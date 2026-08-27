import { execFileSync } from 'node:child_process';
import { loadState, savePeriod, resolvePeriod, writeArchived } from '../core/state.js';
import { saveConfig, loadConfig } from '../core/config.js';
import { computeMetrics } from '../core/metrics.js';
import { round4 } from '../core/models.js';
import { c, fmtNum, table, heading, kv, fmtDate } from '../util/fmt.js';
import { asString } from '../util/args.js';

const API_VERSION = '2022-11-28';

/**
 * Tokens are read from the environment (or the gh CLI) and never written to
 * disk by this tool.
 */
export function resolveToken(explicit = null) {
  if (explicit) return { token: explicit, source: 'flag' };
  for (const name of ['CCRED_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    if (process.env[name]) return { token: process.env[name], source: `env:${name}` };
  }
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (token) return { token, source: 'gh auth token' };
  } catch {
    /* gh not installed or not logged in - fall through */
  }
  return { token: null, source: null };
}

/** Calendar months touched by [start, end) - a cycle can straddle two. */
export function monthsBetween(start, end) {
  const out = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  let guard = 0;
  while (cursor <= last && guard++ < 24) {
    out.push({ year: cursor.getFullYear(), month: cursor.getMonth() + 1 });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}

export function usagePath(cfg) {
  const gh = cfg.github;
  if (gh.scope === 'enterprise') {
    if (!gh.enterprise) throw new Error('Set your enterprise slug first: ccred config set github.enterprise <slug>');
    return `/enterprises/${encodeURIComponent(gh.enterprise)}/settings/billing/usage`;
  }
  if (gh.scope === 'organization') {
    if (!gh.org) throw new Error('Set your org first: ccred config set github.org <org>');
    return `/organizations/${encodeURIComponent(gh.org)}/settings/billing/usage`;
  }
  if (!gh.username) throw new Error('Set your GitHub username first: ccred config set github.username <login>');
  return `/users/${encodeURIComponent(gh.username)}/settings/billing/usage`;
}

export async function ghFetch(url, token) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'copilot-credit-tracker',
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const detail = body?.message || `HTTP ${res.status}`;
    const err = new Error(`GitHub billing API: ${detail}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function detectUsername(cfg, token) {
  const me = await ghFetch(`${cfg.github.apiBase}/user`, token);
  return me?.login || null;
}

/** `--scope`, `--org` and `--enterprise` override config for one invocation. */
export function applyScopeFlags(cfg, flags) {
  let out = cfg;
  const scope = asString(flags.scope, null);
  if (scope) out = { ...out, github: { ...out.github, scope } };
  const org = asString(flags.org, null);
  if (org) out = { ...out, github: { ...out.github, org, scope: scope || 'organization' } };
  const enterprise = asString(flags.enterprise, null);
  if (enterprise) out = { ...out, github: { ...out.github, enterprise, scope: scope || 'enterprise' } };
  return out;
}

/**
 * Learn and remember the login for a personal scope. Skipped on a dry run,
 * which must neither touch the network nor write to the config file.
 */
export async function ensureUsername(cfg, token, { dryRun = false } = {}) {
  if (cfg.github.scope !== 'personal' || cfg.github.username || !token || dryRun) return cfg;
  const login = await detectUsername(cfg, token);
  if (!login) return cfg;
  const stored = loadConfig();
  stored.github.username = login;
  saveConfig(stored);
  return { ...cfg, github: { ...cfg.github, username: login } };
}

/** The billing-usage URLs covering a cycle, which can straddle two months. */
export function usageUrls(cfg, period, { now = Date.now(), placeholder = false } = {}) {
  const path =
    placeholder && cfg.github.scope === 'personal' && !cfg.github.username
      ? '/users/<your-login>/settings/billing/usage'
      : usagePath(cfg);
  const start = new Date(period.start);
  const end = new Date(period.end);
  const months = monthsBetween(start, new Date(Math.min(now, end.getTime())));
  return { path, months, urls: months.map(({ year, month }) => `${cfg.github.apiBase}${path}?year=${year}&month=${month}`) };
}

export async function fetchUsageItems(urls, token) {
  const items = [];
  const errors = [];
  for (const url of urls) {
    try {
      const body = await ghFetch(url, token);
      items.push(...(body?.usageItems || []));
    } catch (err) {
      errors.push({ url, message: err.message, status: err.status });
    }
  }
  return { items, errors };
}

/** Turn the first failure into something that says what to do about it. */
export function describeUsageFailure(errors) {
  const first = errors[0];
  const hint =
    first.status === 404
      ? [
          '',
          '  This endpoint needs the enhanced billing platform and a token with "Plan" read access.',
          '  GitHub Enterprise Server may not expose it at all - download the usage report from the',
          '  web UI and run `ccred import --file <report.csv>` instead.',
        ].join('\n')
      : first.status === 403
        ? '\n  The token is missing the billing/Plan read permission, or your org restricts it.'
        : '';
  return new Error(`${first.message}${hint}`);
}

export function isPremiumRequestItem(item) {
  const product = String(item.product || '').toLowerCase();
  const sku = String(item.sku || '').toLowerCase();
  return product.includes('copilot') && (sku.includes('premium') || sku.includes('request'));
}

export async function cmdSync(flags, positionals, { json }) {
  const state = loadState();
  const period = resolvePeriod(positionals[0] || asString(flags.period, null), state) || state.period;
  let cfg = applyScopeFlags(state.cfg, flags);
  const dryRun = flags['dry-run'] === true;

  const { token, source } = resolveToken(asString(flags.token, null));
  if (!token && !dryRun) {
    throw new Error(
      'No GitHub token found. Set GITHUB_TOKEN (needs the "Plan" read-only permission for billing usage), or sign in with `gh auth login`.',
    );
  }
  cfg = await ensureUsername(cfg, token, { dryRun });

  const { months, urls } = usageUrls(cfg, period, { placeholder: dryRun });
  const start = new Date(period.start);
  const end = new Date(period.end);

  if (dryRun) {
    if (json) return { urls, scope: cfg.github.scope, tokenSource: source };
    console.log(heading('Dry run'));
    console.log(kv('scope', cfg.github.scope));
    console.log(kv('token', source ? c.green(source) : c.red('none found')));
    for (const u of urls) console.log(`  GET ${u}`);
    console.log('');
    return null;
  }

  const { items, errors } = await fetchUsageItems(urls, token);
  if (errors.length && !items.length) throw describeUsageFailure(errors);

  const inRange = items.filter((item) => {
    if (!item.date) return true;
    const d = new Date(`${item.date}T00:00:00`);
    return d >= start && d < end;
  });
  const premium = inRange.filter(isPremiumRequestItem);

  const bySku = {};
  for (const item of premium) {
    const key = item.sku || 'unknown';
    bySku[key] = round4((bySku[key] || 0) + (Number(item.quantity) || 0));
  }
  const totalRequests = round4(Object.values(bySku).reduce((a, b) => a + b, 0));
  const netAmount = round4(premium.reduce((a, item) => a + (Number(item.netAmount) || 0), 0));

  period.sync = {
    at: new Date().toISOString(),
    scope: cfg.github.scope,
    target: cfg.github.enterprise || cfg.github.org || cfg.github.username || null,
    apiBase: cfg.github.apiBase,
    months,
    reported: { premiumRequests: totalRequests, netAmount, bySku, items: premium.length },
    partial: errors.length > 0,
  };
  // Syncing a closed cycle must update its archive, not the live ledger.
  if (period.id === state.period.id) savePeriod(period);
  else writeArchived(period);

  const metrics = computeMetrics(period, cfg, { table: state.table });
  const drift = round4(totalRequests - metrics.burn.credits);

  if (json) return { sync: period.sync, ledgerCredits: metrics.burn.credits, drift, errors };

  console.log(heading(`Synced ${period.id} from GitHub (${cfg.github.scope})`));
  console.log(kv('window', `${fmtDate(start)} - ${fmtDate(end)}`));
  console.log(kv('token', c.dim(source)));
  console.log(kv('reported', `${fmtNum(totalRequests)} premium requests`));
  if (netAmount) console.log(kv('billed', `$${fmtNum(netAmount)}`));
  console.log(kv('local ledger', `${fmtNum(metrics.burn.credits)} credits`));
  console.log(
    kv(
      'drift',
      drift > 0
        ? c.yellow(`+${fmtNum(drift)} requests GitHub counted that you did not log`)
        : drift < 0
          ? c.yellow(`${fmtNum(drift)} - you logged more than GitHub counted`)
          : c.green('exact match'),
    ),
  );
  if (Object.keys(bySku).length) {
    console.log('');
    console.log(
      table(
        Object.entries(bySku).map(([sku, qty]) => [sku, fmtNum(qty)]),
        { head: ['sku', 'quantity'], align: ['left', 'right'] },
      ),
    );
  }
  if (errors.length) {
    console.log('');
    for (const e of errors) console.log(c.yellow(`  partial: ${e.message}`));
  }
  // Sync only reports the gap; import is what closes it.
  if (drift > 0) {
    console.log('');
    console.log(
      c.dim(`  Bring those ${fmtNum(drift)} credits into the ledger:  ccred import${period.id === state.period.id ? '' : ` ${period.id}`}`),
    );
  }
  console.log('');
  return null;
}
