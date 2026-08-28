import fs from 'node:fs';
import path from 'node:path';
import { loadState, savePeriod, resolvePeriod, writeArchived } from '../core/state.js';
import { computeMetrics } from '../core/metrics.js';
import { round4 } from '../core/models.js';
import { bucketRecords, planImport, applyImport, manualRecords } from '../core/import.js';
import { resolveModel } from '../core/models.js';
import { importedSessions } from '../core/ledger.js';
import { parseCsvRecords } from '../util/csv.js';
import {
  resolveToken,
  applyScopeFlags,
  ensureUsername,
  usageUrls,
  fetchUsageItems,
  describeUsageFailure,
} from './sync.js';
import { c, fmtNum, fmtPct, fmtTokens, table, heading, kv, fmtDate, budgetBar, plural } from '../util/fmt.js';
import { asString, asList } from '../util/args.js';

const STRATEGIES = ['gap', 'replace'];
const QUANTITY_MODES = ['billed', 'raw'];

/**
 * A file the user downloaded: GitHub's usage report as CSV, the billing API's
 * JSON response saved verbatim, or a bare array of usage items. Whichever it
 * is, the result is a list of raw records for `bucketRecords` to normalize.
 */
export function readUsageFile(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`No such file: ${resolved}`);
  const text = fs.readFileSync(resolved, 'utf8');
  const ext = path.extname(resolved).toLowerCase();
  const tabular = ext === '.csv' || ext === '.tsv';
  const looksJson = /^\s*[[{]/.test(text);

  if (ext === '.json' || (!tabular && looksJson)) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${resolved} is not valid JSON (${err.message}).`);
    }
    const items = Array.isArray(parsed) ? parsed : parsed.usageItems || parsed.items || parsed.data;
    if (!Array.isArray(items)) {
      throw new Error(`${resolved} has no usage items. Expected an array, or an object with "usageItems".`);
    }
    return { records: items, format: 'json', file: resolved };
  }

  const records = parseCsvRecords(text);
  if (!records.length) throw new Error(`${resolved} has no data rows.`);
  return { records, format: 'csv', file: resolved };
}

/**
 * `--credits 142` or `--credits opus=60,sonnet=33`. The model is resolved
 * properly rather than SKU-matched, so short ids like `o3` work and a typo
 * gets the usual "did you mean" instead of landing as unattributed.
 */
export function parseCreditSpecs(value, table) {
  if (value === true) throw new Error('--credits expects a number, e.g. --credits 142 or --credits opus=60,sonnet=33');
  const specs = [];
  for (const raw of asList(value)) {
    const eq = raw.lastIndexOf('=');
    const hasModel = eq > 0;
    const amount = Number(hasModel ? raw.slice(eq + 1) : raw);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`--credits expects a number or <model>=<number>, got "${raw}"`);
    }
    specs.push({
      model: hasModel ? resolveModel(raw.slice(0, eq).trim(), table).id : null,
      credits: amount,
    });
  }
  return specs;
}

function pickOne(value, allowed, flagName, fallback) {
  const v = asString(value, null);
  if (!v) return fallback;
  if (!allowed.includes(v)) throw new Error(`--${flagName} must be one of: ${allowed.join(', ')}`);
  return v;
}

export async function cmdImport(flags, positionals, { json }) {
  const state = loadState();
  const ref = positionals[0] || asString(flags.period, null);
  const period = resolvePeriod(ref, state);
  if (!period) throw new Error(`No cycle "${ref}". Run \`ccred history\` to see what is stored.`);

  if (flags.clear === true) return clearImported(period, state, { json });

  const dryRun = flags['dry-run'] === true;
  const strategy = flags.replace === true ? 'replace' : pickOne(flags.strategy, STRATEGIES, 'strategy', 'gap');
  const quantity = pickOne(flags.quantity, QUANTITY_MODES, 'quantity', 'billed');
  const file = asString(flags.file ?? flags.from, null);

  // ---- 1. get the usage records: by hand, from a file, or from GitHub ------
  let records;
  let source;
  let sourceLabel;
  let errors = [];
  let cfg = state.cfg;

  const creditSpecs = flags.credits === undefined ? [] : parseCreditSpecs(flags.credits, state.table);

  if (creditSpecs.length) {
    records = manualRecords(creditSpecs, period);
    source = 'manual';
    const total = creditSpecs.reduce((a, sp) => a + sp.credits, 0);
    sourceLabel = `entered by hand ${c.dim(`(${fmtNum(total)} credits as an opening balance)`)}`;
  } else if (file) {
    const read = readUsageFile(file);
    records = read.records;
    source = `file:${path.basename(read.file)}`;
    sourceLabel = `${read.file} ${c.dim(`(${read.format}, ${records.length} rows)`)}`;
  } else {
    cfg = applyScopeFlags(state.cfg, flags);
    const { token, source: tokenSource } = resolveToken(asString(flags.token, null));
    if (!token && !dryRun) {
      throw new Error(
        [
          'No GitHub token found. Set GITHUB_TOKEN (needs the "Plan" read-only permission for billing usage),',
          'or sign in with `gh auth login`.',
          '',
          'Cannot get a token? Neither of these touches the API:',
          '  ccred import --file usage.csv    from a usage report you downloaded',
          '  ccred import --credits 142       from a number you can only read off a screen',
        ].join('\n  '),
      );
    }
    cfg = await ensureUsername(cfg, token, { dryRun });
    const { urls } = usageUrls(cfg, period, { placeholder: dryRun });

    if (dryRun && !token) {
      if (json) return { urls, scope: cfg.github.scope, tokenSource };
      console.log(heading('Dry run'));
      console.log(kv('scope', cfg.github.scope));
      console.log(kv('token', c.red('none found')));
      for (const u of urls) console.log(`  GET ${u}`);
      console.log('');
      return null;
    }

    const fetched = await fetchUsageItems(urls, token);
    if (fetched.errors.length && !fetched.items.length) throw describeUsageFailure(fetched.errors);
    records = fetched.items;
    errors = fetched.errors;
    source = `github:${cfg.github.scope}`;
    sourceLabel = `GitHub billing usage ${c.dim(`(${cfg.github.scope}, ${tokenSource})`)}`;
  }

  // ---- 2. work out what would change --------------------------------------
  const { buckets, rejected } = bucketRecords(records, {
    table: state.table,
    start: period.start,
    end: period.end,
    quantity,
  });
  const plan = planImport(period, buckets, { strategy });
  const before = computeMetrics(period, cfg, { table: state.table });

  const byDay = flags['by-day'] === true;

  if (dryRun) {
    if (json) return { dryRun: true, period: period.id, strategy, quantity, plan: serializePlan(plan), rejected };
    renderPlan(period, plan, { sourceLabel, source, rejected, before, dryRun: true, quantity, strategy, byDay });
    return null;
  }

  // ---- 3. write it ---------------------------------------------------------
  if (plan.additions.length || plan.dropping.length) {
    applyImport(period, plan, cfg, { source });
    // Importing into a finished cycle must update its archive, not the ledger.
    if (period.id === state.period.id) savePeriod(period);
    else writeArchived(period);
  }

  const after = computeMetrics(period, cfg, { table: state.table });
  if (json) {
    return {
      period: period.id,
      source,
      strategy,
      quantity,
      imported: serializePlan(plan),
      rejected,
      errors,
      burn: after.burn,
    };
  }

  renderPlan(period, plan, { sourceLabel, source, rejected, before, after, errors, quantity, strategy, byDay });
  return null;
}

function serializePlan(plan) {
  const strip = (b) => ({
    date: b.dateKey,
    model: b.modelId,
    label: b.label,
    multiplier: b.multiplier,
    credits: b.credits,
    requests: b.requests,
    attributed: b.attributed,
    skus: [...b.skus],
  });
  return {
    totals: plan.totals,
    added: plan.additions.map(strip),
    skipped: plan.skipped.map((s) => ({ ...strip(s), reason: s.reason, alreadyHeld: s.alreadyHeld })),
    replaced: plan.dropping.length,
  };
}

function renderPlan(
  period,
  plan,
  { sourceLabel, source, rejected, before, after, errors = [], dryRun = false, quantity, strategy, byDay = false },
) {
  const { totals, additions, skipped } = plan;
  const verb = dryRun ? 'Would import' : 'Imported';
  const manual = source === 'manual';

  console.log(heading(`${verb} ${period.id} ${c.dim(`(${fmtDate(period.start)} - ${fmtDate(period.end)})`)}`));
  console.log(kv('source', sourceLabel));
  if (strategy === 'replace') console.log(kv('strategy', `replace ${c.dim(`(${plan.dropping.length} earlier backfill entries dropped)`)}`));
  if (quantity === 'raw') console.log(kv('quantity', c.dim('read as raw interactions, multiplied by the model rate')));

  if (!additions.length) {
    console.log(
      kv(
        'added',
        skipped.length
          ? c.green('nothing - the ledger already covers every day GitHub reports')
          : c.dim('nothing - no premium-request usage found in this cycle'),
      ),
    );
  } else {
    const spread = manual
      ? c.dim('as an opening balance on the first day of the cycle')
      : `over ${fmtNum(totals.days)} ${plural(totals.days, 'day')}`;
    console.log(
      kv(
        'added',
        `${c.bold(`${fmtNum(totals.credits)} ${plural(totals.credits, 'credit')}`)} ${spread} ${c.dim(
          `(${fmtNum(totals.requests)} premium ${plural(totals.requests, 'request')}, ${totals.models} ${plural(totals.models, 'model')})`,
        )}`,
      ),
    );
    if (totals.toppedUp) {
      console.log(
        kv(
          'topped up',
          c.dim(
            manual
              ? 'the balance already held is kept; only the increase was added'
              : `${totals.toppedUp} ${plural(totals.toppedUp, 'day')} where you had already logged part of the spend`,
          ),
        ),
      );
    }
    if (totals.unattributed > 0) {
      console.log(
        kv(
          'unattributed',
          c.yellow(
            manual
              ? `${fmtNum(totals.unattributed)} credits with no model given - add one with --credits opus=60`
              : `${fmtNum(totals.unattributed)} credits GitHub reported without naming a model`,
          ),
        ),
      );
    }
  }
  if (totals.ledgerAhead > 0) {
    console.log(
      kv('ledger ahead', c.yellow(`${fmtNum(totals.ledgerAhead)} credits logged beyond what GitHub reports - left alone`)),
    );
  }

  const tokenTotal = additions.reduce((a, b) => a + b.tokens.input + b.tokens.output + b.tokens.context, 0);
  if (tokenTotal > 0) {
    console.log(kv('tokens', `${fmtTokens(tokenTotal)} carried in from the source`));
  } else if (!manual) {
    console.log(kv('tokens', c.dim('not reported - GitHub bills per premium request, not per token')));
  }

  if (after) {
    const { burn } = after;
    console.log('');
    console.log(
      `  ${budgetBar(burn.credits, burn.allowance, 30)} ${c.bold(
        `${fmtNum(burn.credits)}${burn.allowance ? `/${fmtNum(burn.allowance)}` : ''}`,
      )} ${burn.allowance ? c.dim(fmtPct(burn.pctUsed)) : c.dim('credits')}`,
    );
    if (before && after.burn.credits !== before.burn.credits) {
      console.log(c.dim(`  was ${fmtNum(before.burn.credits)} before this import`));
    }
  }

  if (additions.length && byDay) {
    console.log('');
    console.log(
      table(
        additions.map((a) => [
          c.dim(a.dateKey),
          a.label,
          c.dim(`x${fmtNum(a.multiplier)}`),
          fmtNum(a.credits),
          fmtNum(a.requests),
          a.toppedUp ? c.dim(`+ ${fmtNum(a.alreadyHeld)} already logged`) : '',
        ]),
        { head: ['day', 'model', 'mult', 'credits', 'requests', ''], align: ['left', 'left', 'left', 'right', 'right', 'left'] },
      ),
    );
  } else if (additions.length) {
    const byModel = new Map();
    for (const add of additions) {
      const row = byModel.get(add.modelId) || { label: add.label, multiplier: add.multiplier, credits: 0, requests: 0, days: new Set() };
      row.credits = round4(row.credits + add.credits);
      row.requests = round4(row.requests + add.requests);
      row.days.add(add.dateKey);
      byModel.set(add.modelId, row);
    }
    console.log('');
    console.log(
      table(
        [...byModel.values()]
          .sort((a, b) => b.credits - a.credits)
          .map((r) => [r.label, c.dim(`x${fmtNum(r.multiplier)}`), fmtNum(r.credits), fmtNum(r.requests), c.dim(`${r.days.size}d`)]),
        { head: ['model', 'mult', 'credits', 'requests', 'days'], align: ['left', 'left', 'right', 'right', 'right'] },
      ),
    );
  }

  const dropped = Object.entries(rejected || {}).filter(([, n]) => n > 0);
  if (dropped.length) {
    const words = {
      notPremium: 'not Copilot premium requests',
      outsideWindow: 'dated outside this cycle',
      undated: 'without a usable date',
      zero: 'with no usage',
    };
    console.log('');
    console.log(c.dim(`  skipped ${dropped.map(([k, n]) => `${n} ${words[k] || k}`).join(', ')}`));
  }
  for (const e of errors) console.log(c.yellow(`  partial: ${e.message}`));

  console.log('');
  if (dryRun) {
    console.log(c.dim('  Nothing was written. Drop --dry-run to import.'));
  } else if (additions.length) {
    if (manual) {
      console.log(c.dim('  An opening balance counts toward your budget, pace and projection. It has no daily'));
      console.log(c.dim('  shape and no model efficiency, so it never shows up as a busiest day. Check the'));
      console.log(c.dim('  number again later and re-run - only the difference is added.'));
    } else {
      console.log(c.dim('  Backfilled days count toward burn, but carry no session shape or prompt length -'));
      console.log(c.dim('  the billing data has neither. Everything you log from here does.'));
    }
    console.log('');
    console.log(c.dim('  ccred report        the full picture, including the month you just pulled in'));
  }
  console.log('');
}

/**
 * `ccred import --clear` - drop backfilled entries and leave logged prompts
 * untouched, for when the wrong scope or the wrong file went in.
 */
export function clearImported(period, state, { json }) {
  const removed = new Set(importedSessions(period));
  const credits = round4(
    [...removed].reduce((a, s) => a + s.prompts.reduce((x, p) => x + (p.credits || 0) + (p.tokenCredits || 0), 0), 0),
  );
  period.sessions = period.sessions.filter((s) => !removed.has(s));
  delete period.lastImport;
  if (period.id === state.period.id) savePeriod(period);
  else writeArchived(period);

  if (json) return { cleared: removed.size, credits, period: period.id };
  console.log(
    `${c.yellow('cleared')} ${removed.size} backfilled ${plural(removed.size, 'entry', 'entries')} worth ${fmtNum(
      credits,
    )} credits from ${period.id} ${c.dim('(logged prompts untouched)')}`,
  );
  return null;
}
