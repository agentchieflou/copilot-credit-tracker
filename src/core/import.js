/**
 * Backfill: turn GitHub's billing usage into ledger entries so the tracker can
 * be adopted mid-cycle instead of only from today forward.
 *
 * `sync` answers "does my ledger match GitHub's count?". This answers "I just
 * installed this on the 20th - what have I already spent?" by writing the month
 * so far into the ledger as real, budgeted spend.
 *
 * Two things keep that honest:
 *
 *  - Imported entries are marked `origin: 'import'`. GitHub reports a day, a
 *    SKU and a quantity - never which prompts belonged together or how long
 *    they were - so these count toward burn, daily shape and per-model spend,
 *    and stay out of the session-shape and prompt-length statistics they cannot
 *    legitimately inform.
 *  - Importing fills the gap rather than appending. For each day and model it
 *    compares GitHub's number against what the ledger already holds and adds
 *    only the difference, so re-running is a no-op and prompts logged by hand
 *    are never double-counted.
 */

import { round4, loadModelTable } from './models.js';
import { newId, tokenCredits, ORIGIN_IMPORT, isDerived } from './ledger.js';
import { localDateKey } from './metrics.js';

export { ORIGIN_IMPORT };

/**
 * Where GitHub bills premium requests without naming the model. The multiplier
 * is 1 so an unattributed quantity lands in the ledger as exactly that many
 * credits. `synthetic` keeps it out of SKU matching - it would otherwise
 * out-match the real model name inside "Copilot Premium Request - Claude ...".
 */
export const UNATTRIBUTED = {
  id: 'copilot-premium-request',
  label: 'Premium request (model not reported)',
  vendor: 'github',
  multiplier: 1,
  synthetic: true,
  aliases: [],
};

/** Below this, a difference is floating-point noise rather than real spend. */
const EPSILON = 1e-4;

/**
 * The same fact wears different names in the API (`netAmount`), in GitHub's CSV
 * export ("Net Amount") and in whatever the user was tracking with before.
 */
const FIELD_ALIASES = {
  date: ['date', 'day', 'usagedate', 'timestamp', 'createdat', 'time'],
  product: ['product', 'productname'],
  sku: ['sku', 'skuname', 'item', 'lineitem', 'description'],
  quantity: ['quantity', 'qty', 'premiumrequests', 'premiumrequest', 'requests', 'credits', 'usage', 'count'],
  netAmount: ['netamount', 'net', 'totalamount', 'total'],
  grossAmount: ['grossamount', 'gross'],
  unitType: ['unittype', 'unit'],
  model: ['model', 'modelname', 'modelid'],
  inputTokens: ['inputtokens', 'tokensinput', 'prompttokens', 'input'],
  outputTokens: ['outputtokens', 'tokensoutput', 'completiontokens', 'output'],
  contextTokens: ['contexttokens', 'tokenscontext', 'context'],
  repository: ['repositoryname', 'repository', 'repo'],
  organization: ['organizationname', 'organization', 'org'],
};

function normalizeKey(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(raw, field) {
  const byKey = new Map(Object.keys(raw).map((k) => [normalizeKey(k), raw[k]]));
  for (const alias of FIELD_ALIASES[field]) {
    const v = byKey.get(alias);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/** Tolerate "1,234.5", "$12.00" and blanks; never return NaN. */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * A bare `YYYY-MM-DD` through `new Date()` is parsed as UTC midnight, which is
 * the previous day west of Greenwich - and the day is the whole point here, so
 * date-only values are pinned to local noon instead.
 */
export function parseUsageDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0, 0);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]), 12, 0, 0, 0);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One usage line, however it was spelled, in the shape the rest of this file wants. */
export function normalizeRecord(raw) {
  return {
    date: pick(raw, 'date'),
    product: pick(raw, 'product'),
    sku: pick(raw, 'sku'),
    unitType: pick(raw, 'unitType'),
    model: pick(raw, 'model'),
    quantity: toNumber(pick(raw, 'quantity')),
    netAmount: toNumber(pick(raw, 'netAmount')),
    tokens: {
      input: toNumber(pick(raw, 'inputTokens')),
      output: toNumber(pick(raw, 'outputTokens')),
      context: toNumber(pick(raw, 'contextTokens')),
    },
  };
}

/**
 * Keep Copilot premium-request lines and drop Actions minutes, storage and the
 * rest. An explicit model column means the file is model usage already.
 */
export function isPremiumRequestRecord(rec) {
  if (rec.model) return true;
  const product = String(rec.product || '').toLowerCase();
  const sku = String(rec.sku || '').toLowerCase();
  const unit = String(rec.unitType || '').toLowerCase();
  if (product && !product.includes('copilot') && !sku.includes('copilot')) return false;
  const hay = `${product} ${sku} ${unit}`;
  return hay.includes('premium') || hay.includes('request');
}

/**
 * Find the model named inside a SKU like "Copilot Premium Request - Claude
 * Sonnet 4.5". Punctuation is stripped from both sides and the longest match
 * wins, so "claude-sonnet-4.5" beats the "claude-sonnet-4" it contains. Short
 * keys are ignored - a two-character alias hits far too much noise.
 */
export function inferModel(text, table = loadModelTable()) {
  if (!text) return null;
  const hay = String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!hay) return null;
  let best = null;
  for (const model of table.models) {
    if (model.synthetic) continue;
    for (const raw of [model.id, model.label, ...(model.aliases || [])]) {
      const key = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key.length < 4 || !hay.includes(key)) continue;
      if (!best || key.length > best.length) best = { model, length: key.length };
    }
  }
  return best ? best.model : null;
}

/**
 * Collapse usage lines into one bucket per day and model.
 *
 * `quantity` says how to read GitHub's number:
 *   billed - the premium-request count with the multiplier already applied.
 *            This is what the billing API reports and what `sync` compares the
 *            ledger against, so it is the default.
 *   raw    - the number of model interactions, still to be multiplied.
 */
export function bucketRecords(records, { table = loadModelTable(), start, end, quantity = 'billed' } = {}) {
  const buckets = new Map();
  const rejected = { outsideWindow: 0, notPremium: 0, undated: 0, zero: 0 };
  const startAt = start ? new Date(start) : null;
  const endAt = end ? new Date(end) : null;

  for (const raw of records) {
    const rec = normalizeRecord(raw);
    if (!isPremiumRequestRecord(rec)) {
      rejected.notPremium += 1;
      continue;
    }
    const at = parseUsageDate(rec.date);
    if (!at) {
      rejected.undated += 1;
      continue;
    }
    if ((startAt && at < startAt) || (endAt && at >= endAt)) {
      rejected.outsideWindow += 1;
      continue;
    }

    const exact = rec.model ? table.models.find((m) => m.id === String(rec.model).trim().toLowerCase()) : null;
    const matched = exact || inferModel(rec.model || rec.sku, table);
    let model = matched || UNATTRIBUTED;
    let credits;
    let requests;
    if (quantity === 'raw') {
      requests = round4(rec.quantity);
      credits = round4(rec.quantity * Number(model.multiplier));
    } else {
      credits = round4(rec.quantity);
      // A billed quantity on a 0x model cannot be divided back into requests;
      // rather than silently dropping the spend, book it as unattributed.
      if (!Number(model.multiplier) && credits > EPSILON) model = UNATTRIBUTED;
      requests = Number(model.multiplier) ? round4(credits / Number(model.multiplier)) : round4(credits);
    }
    if (Math.abs(credits) < EPSILON && Math.abs(requests) < EPSILON) {
      rejected.zero += 1;
      continue;
    }

    const dateKey = localDateKey(at);
    const key = `${dateKey}|${model.id}`;
    const bucket = buckets.get(key) || {
      key,
      dateKey,
      at,
      modelId: model.id,
      label: model.label || model.id,
      multiplier: Number(model.multiplier),
      attributed: Boolean(matched),
      credits: 0,
      requests: 0,
      netAmount: 0,
      skus: new Set(),
      tokens: { input: 0, output: 0, context: 0 },
    };
    bucket.credits = round4(bucket.credits + credits);
    bucket.requests = round4(bucket.requests + requests);
    bucket.netAmount = round4(bucket.netAmount + rec.netAmount);
    bucket.tokens.input += rec.tokens.input;
    bucket.tokens.output += rec.tokens.output;
    bucket.tokens.context += rec.tokens.context;
    if (rec.sku) bucket.skus.add(String(rec.sku));
    if (at < bucket.at) bucket.at = at;
    buckets.set(key, bucket);
  }

  const list = [...buckets.values()].sort(
    (a, b) => a.dateKey.localeCompare(b.dateKey) || a.modelId.localeCompare(b.modelId),
  );
  return { buckets: list, rejected };
}

/**
 * What the ledger already holds per day and model. Request credits only:
 * GitHub's quantity counts premium requests, so an agreement that also prices
 * tokens must not make the ledger look like it already covers them.
 */
export function ledgerByDayModel(period) {
  const map = new Map();
  for (const session of period.sessions) {
    for (const prompt of session.prompts) {
      const key = `${localDateKey(prompt.at)}|${prompt.model}`;
      const row = map.get(key) || { credits: 0, requests: 0, logged: 0, imported: 0 };
      row.credits = round4(row.credits + (prompt.credits || 0));
      row.requests = round4(row.requests + (prompt.count || 0));
      const bucket = isDerived(session) || isDerived(prompt) ? 'imported' : 'logged';
      row[bucket] = round4(row[bucket] + (prompt.credits || 0));
      map.set(key, row);
    }
  }
  return map;
}

/**
 * Work out what importing would change, without changing anything.
 *
 * strategy `gap`     - add only what the ledger is missing (default, idempotent)
 * strategy `replace` - discard earlier backfills for this cycle first, so a
 *                      revised GitHub report or a changed scope can win
 */
export function planImport(period, buckets, { strategy = 'gap' } = {}) {
  const dropping = strategy === 'replace' ? period.sessions.filter(isDerived) : [];
  const dropped = new Set(dropping.map((s) => s.id));
  const held = ledgerByDayModel({ ...period, sessions: period.sessions.filter((s) => !dropped.has(s.id)) });

  const additions = [];
  const skipped = [];
  for (const bucket of buckets) {
    const have = held.get(bucket.key) || { credits: 0, requests: 0, logged: 0, imported: 0 };
    const creditGap = round4(bucket.credits - have.credits);
    // A free model bills zero credits, so for those the request count is the
    // only thing that can be behind.
    const requestGap = round4(bucket.requests - have.requests);
    const freeModelGap = Math.abs(bucket.credits) < EPSILON && requestGap > EPSILON;

    if (creditGap > EPSILON || freeModelGap) {
      additions.push({
        ...bucket,
        credits: freeModelGap ? 0 : creditGap,
        requests: freeModelGap
          ? requestGap
          : bucket.multiplier
            ? round4(creditGap / bucket.multiplier)
            : creditGap,
        alreadyHeld: have.credits,
        toppedUp: have.credits > EPSILON,
      });
    } else {
      skipped.push({
        ...bucket,
        alreadyHeld: have.credits,
        reason: creditGap < -EPSILON ? 'ledger-ahead' : 'already-covered',
        excess: round4(-creditGap),
      });
    }
  }

  const sumBy = (rows, fn) => round4(rows.reduce((a, r) => a + fn(r), 0));
  const totals = {
    credits: sumBy(additions, (a) => a.credits),
    requests: sumBy(additions, (a) => a.requests),
    entries: additions.length,
    days: new Set(additions.map((a) => a.dateKey)).size,
    models: new Set(additions.map((a) => a.modelId)).size,
    unattributed: sumBy(additions.filter((a) => !a.attributed), (a) => a.credits),
    toppedUp: additions.filter((a) => a.toppedUp).length,
    ledgerAhead: sumBy(skipped.filter((s) => s.reason === 'ledger-ahead'), (s) => s.excess),
  };

  return { additions, skipped, dropping, strategy, totals };
}

/**
 * Build usage records from numbers typed by hand, for the case where neither
 * the API nor an export is available - an org that restricts billing reads to
 * admins leaves a seat holder able to read a total off a screen and nothing
 * more.
 *
 * A hand-entered total is an opening balance, not a day's work: it is dated to
 * the first day of the cycle and labelled as such, so it never invents a
 * busiest day. `specs` is a list of `credits` or `model=credits`.
 */
export function manualRecords(specs, period) {
  const day = localDateKey(new Date(period.start));
  return specs.map(({ model, credits }) => ({
    date: day,
    product: 'copilot',
    sku: model ? `Copilot Premium Request - ${model}` : 'Copilot Premium Request',
    model: model || null,
    quantity: credits,
    unitType: 'request',
  }));
}

/**
 * One closed, single-entry session per day and model. A day of GitHub billing
 * is not a conversation, so it is never presented as one - the origin marker is
 * what lets the metrics engine leave these out of session-shape numbers.
 */
export function applyImport(period, plan, cfg, { source = 'github', at = new Date() } = {}) {
  if (plan.dropping.length) {
    const dropped = new Set(plan.dropping.map((s) => s.id));
    period.sessions = period.sessions.filter((s) => !dropped.has(s.id));
  }

  const stamp = at.toISOString();
  const created = [];
  for (const add of plan.additions) {
    const model = { id: add.modelId, multiplier: add.multiplier };
    const tokens = {
      input: Math.max(0, Math.trunc(add.tokens.input)),
      output: Math.max(0, Math.trunc(add.tokens.output)),
      context: Math.max(0, Math.trunc(add.tokens.context)),
    };
    const prompt = {
      id: newId('p'),
      at: add.at.toISOString(),
      model: add.modelId,
      count: add.requests,
      multiplier: add.multiplier,
      credits: round4(add.credits),
      chars: null,
      words: null,
      tokens,
      tokenCredits: tokenCredits(tokens, model, cfg),
      note: `${add.dateKey} from ${source}`,
      origin: ORIGIN_IMPORT,
      source,
    };
    const session = {
      id: newId('s'),
      label: `${add.label} - ${add.dateKey}`,
      model: add.modelId,
      tags: ['imported'],
      startedAt: add.at.toISOString(),
      endedAt: add.at.toISOString(),
      status: 'closed',
      outcome: null,
      origin: ORIGIN_IMPORT,
      import: {
        source,
        at: stamp,
        dateKey: add.dateKey,
        skus: [...add.skus],
        attributed: add.attributed,
        toppedUp: Boolean(add.toppedUp),
      },
      prompts: [prompt],
    };
    period.sessions.push(session);
    created.push(session);
  }

  period.sessions.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  period.lastImport = {
    at: stamp,
    source,
    strategy: plan.strategy,
    credits: plan.totals.credits,
    requests: plan.totals.requests,
    days: plan.totals.days,
    replaced: plan.dropping.length,
  };
  return created;
}
