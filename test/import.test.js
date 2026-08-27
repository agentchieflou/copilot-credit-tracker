import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, parseCsvRecords, detectDelimiter } from '../src/util/csv.js';
import {
  inferModel,
  parseUsageDate,
  toNumber,
  normalizeRecord,
  isPremiumRequestRecord,
  bucketRecords,
  planImport,
  applyImport,
  manualRecords,
  UNATTRIBUTED,
} from '../src/core/import.js';
import { parseCreditSpecs } from '../src/commands/import.js';
import { describeUsageFailure } from '../src/commands/sync.js';
import { computeMetrics, localDateKey } from '../src/core/metrics.js';
import { loadModelTable } from '../src/core/models.js';
import { defaultConfig } from '../src/core/config.js';

const cfg = defaultConfig();
const table = loadModelTable();

/** A cycle anchored mid-month, the case the tool exists for. */
function emptyPeriod() {
  return {
    schema: 1,
    id: '2026-08',
    start: new Date(2026, 7, 14).toISOString(),
    end: new Date(2026, 8, 14).toISOString(),
    resetDay: 14,
    plan: 'pro',
    planLabel: 'Copilot Pro',
    allowance: 300,
    sessions: [],
    sync: null,
  };
}

function loggedPrompt(model, multiplier, at, extra = {}) {
  return {
    id: `p_${model}_${at.getTime()}`,
    at: at.toISOString(),
    model,
    count: 1,
    multiplier,
    credits: multiplier,
    tokenCredits: 0,
    chars: 400,
    words: 60,
    tokens: { input: 0, output: 0, context: 0 },
    note: null,
    ...extra,
  };
}

function loggedSession(model, prompts) {
  return {
    id: `s_${model}_${prompts[0].at}`,
    label: 'logged work',
    model,
    status: 'closed',
    startedAt: prompts[0].at,
    endedAt: prompts[prompts.length - 1].at,
    outcome: 'solved',
    prompts,
  };
}

/** GitHub's usage report, as the API returns it. */
function usage(date, sku, quantity, extra = {}) {
  return { date, product: 'copilot', sku, quantity, unitType: 'request', netAmount: 0, ...extra };
}

function importInto(period, records, opts = {}) {
  const { buckets } = bucketRecords(records, { table, start: period.start, end: period.end, ...opts });
  const plan = planImport(period, buckets, opts);
  applyImport(period, plan, cfg, { source: 'github:personal', at: new Date(2026, 7, 27, 10) });
  return plan;
}

// ---------------------------------------------------------------- csv reading

test('the csv reader survives quoted commas, CRLF and a BOM', () => {
  const text = '﻿Date,SKU,Quantity\r\n2026-08-15,"Premium Request, Claude Sonnet 4.5",12\r\n';
  const records = parseCsvRecords(text);
  assert.equal(records.length, 1);
  assert.equal(records[0].sku, 'Premium Request, Claude Sonnet 4.5');
  assert.equal(records[0].quantity, '12');
});

test('an escaped quote survives the round trip', () => {
  const rows = parseCsv('a,b\n"say ""hi""",2\n');
  assert.deepEqual(rows[1], ['say "hi"', '2']);
});

test('a spreadsheet that saved semicolons is still readable', () => {
  assert.equal(detectDelimiter('Date;SKU;Quantity'), ';');
  const records = parseCsvRecords('Date;SKU;Quantity\n2026-08-15;Premium Request;3\n');
  assert.equal(records[0].quantity, '3');
});

test('headers are matched loosely, so "Net Amount" and netAmount agree', () => {
  const a = normalizeRecord({ 'Net Amount': '1.50', Date: '2026-08-15', Quantity: '4' });
  const b = normalizeRecord({ netAmount: 1.5, date: '2026-08-15', quantity: 4 });
  assert.equal(a.netAmount, b.netAmount);
  assert.equal(a.quantity, b.quantity);
});

test('quantities survive thousands separators and currency symbols', () => {
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber('$12.00'), 12);
  assert.equal(toNumber(''), 0);
  assert.equal(toNumber('nonsense'), 0);
});

// ------------------------------------------------------------ model matching

test('the model named in a sku is recognised', () => {
  assert.equal(inferModel('Copilot Premium Request - Claude Sonnet 4.5', table).id, 'claude-sonnet-4.5');
  assert.equal(inferModel('copilot_premium_requests_gpt_5_mini', table).id, 'gpt-5-mini');
});

test('the longest model match wins, so 4.5 is not read as 4', () => {
  assert.equal(inferModel('Claude Sonnet 4', table).id, 'claude-sonnet-4');
  assert.equal(inferModel('Claude Sonnet 4.5', table).id, 'claude-sonnet-4.5');
  assert.equal(inferModel('Claude Opus 4.1', table).id, 'claude-opus-4.1');
});

test('a sku with no model in it stays unattributed rather than being guessed', () => {
  assert.equal(inferModel('Copilot Premium Request', table), null);
  assert.equal(inferModel('', table), null);
});

test('non-Copilot line items are not premium requests', () => {
  assert.equal(isPremiumRequestRecord(normalizeRecord(usage('2026-08-15', 'Premium Request', 3))), true);
  assert.equal(
    isPremiumRequestRecord(normalizeRecord({ date: '2026-08-15', product: 'actions', sku: 'Linux 2-core', quantity: 400 })),
    false,
  );
});

// --------------------------------------------------------------- date pinning

test('a bare date lands on that day locally, not the one before it', () => {
  const d = parseUsageDate('2026-08-15');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 15);
  assert.equal(localDateKey(d), '2026-08-15');
});

test('an american-format date is read as month first', () => {
  const d = parseUsageDate('8/15/2026');
  assert.equal(localDateKey(d), '2026-08-15');
});

// -------------------------------------------------------------- the backfill

test('a cycle with nothing logged takes on the whole reported month', () => {
  const period = emptyPeriod();
  const plan = importInto(period, [
    usage('2026-08-15', 'Copilot Premium Request - Claude Opus 4.1', 30),
    usage('2026-08-16', 'Copilot Premium Request - Claude Sonnet 4.5', 9),
  ]);

  assert.equal(plan.totals.credits, 39);
  assert.equal(period.sessions.length, 2);
  const m = computeMetrics(period, cfg, { table, now: new Date(2026, 7, 27) });
  assert.equal(m.burn.credits, 39);
  // 30 credits of Opus at 10x is 3 requests, plus 9 of Sonnet at 1x.
  assert.equal(m.burn.requests, 12);
});

test('usage outside the cycle window is left for the cycle it belongs to', () => {
  const period = emptyPeriod();
  importInto(period, [
    usage('2026-08-13', 'Copilot Premium Request - Claude Sonnet 4.5', 50),
    usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 5),
    usage('2026-09-20', 'Copilot Premium Request - Claude Sonnet 4.5', 70),
  ]);
  assert.equal(computeMetrics(period, cfg, { table }).burn.credits, 5);
});

test('importing twice adds nothing the second time', () => {
  const period = emptyPeriod();
  const records = [usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 12)];
  importInto(period, records);
  const second = importInto(period, records);

  assert.equal(second.totals.credits, 0);
  assert.equal(second.additions.length, 0);
  assert.equal(period.sessions.length, 1);
  assert.equal(computeMetrics(period, cfg, { table }).burn.credits, 12);
});

test('a day you logged by hand is topped up, not counted twice', () => {
  const period = emptyPeriod();
  const at = new Date(2026, 7, 15, 10, 0);
  period.sessions.push(
    loggedSession('claude-sonnet-4.5', [
      loggedPrompt('claude-sonnet-4.5', 1, at),
      loggedPrompt('claude-sonnet-4.5', 1, new Date(2026, 7, 15, 10, 5)),
    ]),
  );

  const plan = importInto(period, [usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 12)]);

  assert.equal(plan.totals.credits, 10, 'only the 10 credits GitHub saw beyond the 2 logged');
  assert.equal(plan.additions[0].toppedUp, true);
  assert.equal(computeMetrics(period, cfg, { table }).burn.credits, 12);
});

test('logging more than GitHub reports leaves the ledger alone', () => {
  const period = emptyPeriod();
  period.sessions.push(
    loggedSession('claude-sonnet-4.5', [
      loggedPrompt('claude-sonnet-4.5', 1, new Date(2026, 7, 15, 10, 0)),
      loggedPrompt('claude-sonnet-4.5', 1, new Date(2026, 7, 15, 10, 5)),
      loggedPrompt('claude-sonnet-4.5', 1, new Date(2026, 7, 15, 10, 9)),
    ]),
  );
  const plan = importInto(period, [usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 1)]);

  assert.equal(plan.additions.length, 0);
  assert.equal(plan.totals.ledgerAhead, 2);
  assert.equal(computeMetrics(period, cfg, { table }).burn.credits, 3);
});

test('replace drops earlier backfills but keeps what you logged', () => {
  const period = emptyPeriod();
  period.sessions.push(loggedSession('claude-sonnet-4.5', [loggedPrompt('claude-sonnet-4.5', 1, new Date(2026, 7, 15, 10, 0))]));
  importInto(period, [usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 40)]);
  assert.equal(computeMetrics(period, cfg, { table }).burn.credits, 40);

  // GitHub revised the month down; a plain re-import could not lower it.
  const plan = importInto(period, [usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 6)], {
    strategy: 'replace',
  });

  assert.equal(plan.dropping.length, 1);
  const m = computeMetrics(period, cfg, { table });
  assert.equal(m.burn.credits, 6);
  assert.equal(m.burn.loggedCredits, 1, 'the hand-logged prompt survived');
  assert.equal(m.sessions.total, 1);
});

test('a quantity with no model named books as an unattributed premium request', () => {
  const period = emptyPeriod();
  importInto(period, [usage('2026-08-15', 'Copilot Premium Request', 4)]);
  const m = computeMetrics(period, cfg, { table });
  assert.equal(m.burn.credits, 4);
  assert.equal(m.models[0].id, UNATTRIBUTED.id);
  assert.equal(m.imported.unattributed, 4);
});

test('raw quantities are multiplied, billed ones are not', () => {
  const billed = emptyPeriod();
  importInto(billed, [usage('2026-08-15', 'Copilot Premium Request - Claude Opus 4.1', 3)]);
  assert.equal(computeMetrics(billed, cfg, { table }).burn.credits, 3);

  const raw = emptyPeriod();
  importInto(raw, [usage('2026-08-15', 'Copilot Premium Request - Claude Opus 4.1', 3)], { quantity: 'raw' });
  assert.equal(computeMetrics(raw, cfg, { table }).burn.credits, 30);
});

test('a free model is tracked by request count even though it bills nothing', () => {
  const period = emptyPeriod();
  importInto(period, [usage('2026-08-15', 'Copilot Premium Request - GPT-4.1', 8)], { quantity: 'raw' });
  const m = computeMetrics(period, cfg, { table });
  assert.equal(m.burn.credits, 0);
  assert.equal(m.burn.requests, 8);
  assert.equal(m.models[0].id, 'gpt-4.1');
});

test('same day and model across several line items collapse into one entry', () => {
  const period = emptyPeriod();
  importInto(period, [
    usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 5, { repositoryName: 'acme/web' }),
    usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 7, { repositoryName: 'acme/api' }),
  ]);
  assert.equal(period.sessions.length, 1);
  assert.equal(computeMetrics(period, cfg, { table }).burn.credits, 12);
});

test('token columns are carried in when the source has them', () => {
  const period = emptyPeriod();
  importInto(period, [
    usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 5, {
      inputTokens: 12000,
      outputTokens: 4000,
      contextTokens: 90000,
    }),
  ]);
  const m = computeMetrics(period, cfg, { table });
  assert.equal(m.tokens.input, 12000);
  assert.equal(m.tokens.output, 4000);
  assert.equal(m.tokens.context, 90000);
});

// -------------------------------------------- keeping the honest numbers honest

test('backfilled spend counts toward burn but invents no sessions', () => {
  const period = emptyPeriod();
  importInto(period, [
    usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 12),
    usage('2026-08-16', 'Copilot Premium Request - Claude Opus 4.1', 30),
  ]);
  const m = computeMetrics(period, cfg, { table, now: new Date(2026, 7, 27) });

  assert.equal(m.burn.credits, 42);
  assert.equal(m.burn.importedCredits, 42);
  assert.equal(m.burn.loggedCredits, 0);
  assert.equal(m.burn.prompts, 0, 'a billed day is spend, not a prompt');
  assert.equal(m.burn.entries, 2);
  assert.equal(m.sessions.total, 0, 'no session shape can be inferred from billing data');
  assert.equal(m.sessions.avgPrompts, 0);
  assert.equal(m.promptLength.counted, 0);
  assert.equal(m.daily.length, 2, 'but the daily shape is real');
});

test('session shape and the re-prompt tax measure only what you logged', () => {
  const period = emptyPeriod();
  period.sessions.push(
    loggedSession('claude-sonnet-4.5', [
      loggedPrompt('claude-sonnet-4.5', 1, new Date(2026, 7, 20, 9, 0)),
      loggedPrompt('claude-sonnet-4.5', 1, new Date(2026, 7, 20, 9, 5)),
    ]),
  );
  importInto(period, [usage('2026-08-15', 'Copilot Premium Request - Claude Opus 4.1', 100)]);

  const m = computeMetrics(period, cfg, { table, now: new Date(2026, 7, 27) });
  assert.equal(m.sessions.total, 1);
  assert.equal(m.sessions.avgPrompts, 2);
  assert.equal(m.sessions.singleRate, 0);
  // 1 of the 2 logged credits went to the follow-up; the 100 backfilled ones
  // had no opener to be a follow-up to, so they are not in the denominator.
  assert.equal(m.sessions.followUpShare, 0.5);
  assert.equal(m.promptLength.coverage, 1);
});

test('per-model spend includes the backfill, per-model efficiency does not', () => {
  const period = emptyPeriod();
  period.sessions.push(
    loggedSession('claude-opus-4.1', [loggedPrompt('claude-opus-4.1', 10, new Date(2026, 7, 20, 9, 0))]),
  );
  importInto(period, [usage('2026-08-15', 'Copilot Premium Request - Claude Opus 4.1', 50)]);

  const opus = computeMetrics(period, cfg, { table }).models.find((mo) => mo.id === 'claude-opus-4.1');
  assert.equal(opus.credits, 60);
  assert.equal(opus.importedCredits, 50);
  assert.equal(opus.soleSessions, 1, 'only the session you actually ran');
  assert.equal(opus.creditsPerSession, 10, 'a backfilled day must not inflate cost-to-finish');
});

test('the import summary says where the numbers came from', () => {
  const period = emptyPeriod();
  importInto(period, [
    usage('2026-08-15', 'Copilot Premium Request - Claude Sonnet 4.5', 12),
    usage('2026-08-18', 'Copilot Premium Request - Claude Sonnet 4.5', 8),
  ]);
  const m = computeMetrics(period, cfg, { table });
  assert.equal(m.imported.credits, 20);
  assert.equal(m.imported.days, 2);
  assert.equal(m.imported.firstDay, '2026-08-15');
  assert.equal(m.imported.lastDay, '2026-08-18');
  assert.deepEqual(m.imported.sources, ['github:personal']);
  assert.equal(m.imported.share, 1);
});

test('a cycle with no import at all reports no import block', () => {
  const period = emptyPeriod();
  period.sessions.push(loggedSession('claude-sonnet-4.5', [loggedPrompt('claude-sonnet-4.5', 1, new Date(2026, 7, 20, 9, 0))]));
  assert.equal(computeMetrics(period, cfg, { table }).imported, null);
});

// --------------------------------------- the way in when the API says no

test('an exact model id beats the loose sku matcher, so short ids survive', () => {
  const period = emptyPeriod();
  // "o3" is two characters - the SKU matcher ignores keys that short, so an
  // explicit model column has to win outright or the spend lands unattributed.
  importInto(period, [{ date: '2026-08-15', product: 'copilot', sku: 'Premium Request', model: 'o3', quantity: 5 }]);
  assert.equal(computeMetrics(period, cfg, { table }).models[0].id, 'o3');
});

test('a hand-entered total lands as an opening balance at the start of the cycle', () => {
  const period = emptyPeriod();
  const records = manualRecords([{ model: null, credits: 142 }], period);
  const { buckets } = bucketRecords(records, { table, start: period.start, end: period.end });
  applyImport(period, planImport(period, buckets), cfg, { source: 'manual' });

  const m = computeMetrics(period, cfg, { table, now: new Date(2026, 7, 27) });
  assert.equal(m.burn.credits, 142);
  assert.equal(m.imported.opening, 142);
  assert.equal(m.daily[0].date, '2026-08-14', 'dated to the first day of the cycle');
  assert.equal(m.daily[0].opening, 142);
  assert.equal(m.sessions.total, 0, 'still not a session');
});

test('an opening balance never wins busiest day', () => {
  const period = emptyPeriod();
  const records = manualRecords([{ model: null, credits: 142 }], period);
  const { buckets } = bucketRecords(records, { table, start: period.start, end: period.end });
  applyImport(period, planImport(period, buckets), cfg, { source: 'manual' });
  period.sessions.push(
    loggedSession('claude-sonnet-4.5', [loggedPrompt('claude-sonnet-4.5', 1, new Date(2026, 7, 20, 9, 0))]),
  );

  const m = computeMetrics(period, cfg, { table, now: new Date(2026, 7, 27) });
  assert.equal(m.burn.busiestDay.date, '2026-08-20', 'the real day of work, not the 142-credit balance');
  assert.equal(m.burn.busiestDay.credits, 1);
});

test('a cycle whose only entry is an opening balance reports no busiest day', () => {
  const period = emptyPeriod();
  const records = manualRecords([{ model: null, credits: 90 }], period);
  const { buckets } = bucketRecords(records, { table, start: period.start, end: period.end });
  applyImport(period, planImport(period, buckets), cfg, { source: 'manual' });
  assert.equal(computeMetrics(period, cfg, { table }).burn.busiestDay, null);
});

test('re-entering a higher balance adds only the increase', () => {
  const period = emptyPeriod();
  const enter = (credits) => {
    const { buckets } = bucketRecords(manualRecords([{ model: null, credits }], period), {
      table,
      start: period.start,
      end: period.end,
    });
    const plan = planImport(period, buckets);
    applyImport(period, plan, cfg, { source: 'manual' });
    return plan;
  };

  enter(142);
  const second = enter(160);
  assert.equal(second.totals.credits, 18);
  assert.equal(computeMetrics(period, cfg, { table }).burn.credits, 160);

  const third = enter(160);
  assert.equal(third.totals.credits, 0, 'entering the same number again changes nothing');
});

test('a per-model balance is attributed and priced by multiplier', () => {
  const period = emptyPeriod();
  const records = manualRecords(
    [
      { model: 'claude-opus-4.1', credits: 60 },
      { model: 'claude-sonnet-4.5', credits: 33 },
    ],
    period,
  );
  const { buckets } = bucketRecords(records, { table, start: period.start, end: period.end });
  applyImport(period, planImport(period, buckets), cfg, { source: 'manual' });

  const m = computeMetrics(period, cfg, { table });
  assert.equal(m.burn.credits, 93);
  assert.equal(m.imported.unattributed, 0);
  const opus = m.models.find((mo) => mo.id === 'claude-opus-4.1');
  assert.equal(opus.credits, 60);
  assert.equal(opus.requests, 6, '60 credits at 10x is 6 premium requests');
});

test('both restricted-access failures name a route that needs no API', () => {
  for (const status of [403, 404]) {
    const err = describeUsageFailure([{ status, message: 'GitHub billing API: nope' }]);
    assert.match(err.message, /--file usage\.csv/, `status ${status} should offer the file route`);
    assert.match(err.message, /--credits 142/, `status ${status} should offer the manual route`);
  }
});

test('a bare --credits is a usage error, not a silent no-op', () => {
  assert.throws(() => parseCreditSpecs(true, table), /--credits expects a number/);
  assert.throws(() => parseCreditSpecs(['opus=nope'], table), /expects a number/);
});

test('--credits resolves model names the same way logging does', () => {
  assert.deepEqual(parseCreditSpecs(['opus=60'], table), [{ model: 'claude-opus-4.1', credits: 60 }]);
  assert.deepEqual(parseCreditSpecs(['142'], table), [{ model: null, credits: 142 }]);
  assert.throws(() => parseCreditSpecs(['nosuchmodel=5'], table), /Unknown model/);
});
