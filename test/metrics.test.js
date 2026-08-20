import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/core/metrics.js';
import { defaultConfig } from '../src/core/config.js';

const cfg = defaultConfig();

function prompt(model, multiplier, at, extra = {}) {
  return {
    id: `p_${at}`,
    at: new Date(2026, 7, 10, 9, at).toISOString(),
    model,
    count: 1,
    multiplier,
    credits: multiplier,
    tokenCredits: 0,
    chars: null,
    words: null,
    tokens: { input: 0, output: 0, context: 0 },
    note: null,
    ...extra,
  };
}

function fixture() {
  return {
    id: '2026-08',
    start: new Date(2026, 7, 1).toISOString(),
    end: new Date(2026, 8, 1).toISOString(),
    allowance: 300,
    plan: 'pro',
    planLabel: 'Copilot Pro',
    sessions: [
      {
        id: 's_one',
        label: 'one shot',
        model: 'claude-opus-4.1',
        status: 'closed',
        startedAt: new Date(2026, 7, 10, 9, 0).toISOString(),
        endedAt: new Date(2026, 7, 10, 9, 5).toISOString(),
        outcome: 'solved',
        prompts: [prompt('claude-opus-4.1', 10, 0, { chars: 1800, words: 300 })],
      },
      {
        id: 's_many',
        label: 'grind',
        model: 'claude-sonnet-4.5',
        status: 'closed',
        startedAt: new Date(2026, 7, 10, 9, 10).toISOString(),
        endedAt: new Date(2026, 7, 10, 9, 40).toISOString(),
        outcome: 'solved',
        prompts: [
          prompt('claude-sonnet-4.5', 1, 10, { chars: 100, words: 15 }),
          prompt('claude-sonnet-4.5', 1, 20, { chars: 90, words: 12 }),
          prompt('claude-sonnet-4.5', 1, 30, {
            chars: 80,
            words: 11,
            tokens: { input: 2000, output: 1000, context: 50000 },
          }),
          prompt('claude-sonnet-4.5', 1, 40, { chars: 70, words: 10 }),
        ],
      },
    ],
    sync: null,
  };
}

const now = new Date(2026, 7, 16, 0, 0); // half way through the cycle

test('burn rate reflects credits, allowance and pace', () => {
  const m = computeMetrics(fixture(), cfg, { now });
  assert.equal(m.burn.credits, 14);
  assert.equal(m.burn.allowance, 300);
  assert.equal(m.burn.remaining, 286);
  assert.equal(m.burn.prompts, 5);
  assert.equal(m.burn.pace, 'under', 'well below the straight-line budget');
  assert.ok(m.burn.projected > 14 && m.burn.projected < 40);
  assert.equal(m.burn.exhaustion, null, 'nowhere near running out');
});

test('over-budget spending is reported as over pace', () => {
  const period = fixture();
  period.allowance = 10;
  const m = computeMetrics(period, cfg, { now });
  assert.equal(m.burn.pace, 'over');
  assert.equal(m.burn.remaining, 0);
  assert.equal(m.burn.over, 4);
});

test('session shape separates one-shot from multi-prompt work', () => {
  const m = computeMetrics(fixture(), cfg, { now });
  assert.equal(m.sessions.total, 2);
  assert.equal(m.sessions.single, 1);
  assert.equal(m.sessions.multi, 1);
  assert.equal(m.sessions.singleRate, 0.5);
  assert.equal(m.sessions.avgPrompts, 2.5);
  assert.equal(m.sessions.maxPrompts, 4);
  // 3 follow-up prompts on Sonnet, 1 credit each, out of 14 total.
  assert.equal(m.sessions.followUpCredits, 3);
  assert.equal(m.sessions.followUpShare, 0.2143, 'ratios are stored rounded to 4 places');
  const oneShot = m.sessions.distribution.find((d) => d.label === '1 prompt');
  assert.equal(oneShot.count, 1);
  assert.equal(oneShot.credits, 10);
});

test('per-model efficiency uses sessions run wholly on that model', () => {
  const m = computeMetrics(fixture(), cfg, { now });
  const opus = m.models.find((x) => x.id === 'claude-opus-4.1');
  const sonnet = m.models.find((x) => x.id === 'claude-sonnet-4.5');

  assert.equal(opus.credits, 10);
  assert.equal(opus.avgPromptsPerSession, 1);
  assert.equal(opus.singleRate, 1);
  assert.equal(opus.creditsPerSession, 10);

  assert.equal(sonnet.credits, 4);
  assert.equal(sonnet.avgPromptsPerSession, 4);
  assert.equal(sonnet.singleRate, 0);
  assert.equal(sonnet.creditsPerSession, 4);

  // The headline comparison: Opus at 10x still cost more per finished session.
  assert.ok(opus.creditsPerSession > sonnet.creditsPerSession);
  assert.equal(m.models[0].id, 'claude-opus-4.1', 'sorted by credits spent');
});

test('prompt length buckets sessions by their opening prompt', () => {
  const m = computeMetrics(fixture(), cfg, { now });
  assert.equal(m.promptLength.counted, 5);
  assert.equal(m.promptLength.coverage, 1);

  const terse = m.promptLength.buckets.find((b) => b.label.startsWith('terse'));
  const long = m.promptLength.buckets.find((b) => b.label.startsWith('long'));
  assert.equal(terse.openerSessions, 1);
  assert.equal(terse.avgFollowUps, 3, 'the short opener needed three follow-ups');
  assert.equal(long.openerSessions, 1);
  assert.equal(long.avgFollowUps, 0, 'the long opener needed none');
});

test('unmeasured prompts are excluded rather than counted as zero', () => {
  const period = fixture();
  period.sessions[0].prompts[0].chars = null;
  period.sessions[0].prompts[0].words = null;
  const m = computeMetrics(period, cfg, { now });
  assert.equal(m.promptLength.counted, 4);
  assert.equal(m.promptLength.avgChars, 85, 'average of the four measured prompts only');
});

test('token dimensions are tracked separately and only over prompts that have them', () => {
  const m = computeMetrics(fixture(), cfg, { now });
  assert.equal(m.tokens.input, 2000);
  assert.equal(m.tokens.output, 1000);
  assert.equal(m.tokens.context, 50000);
  assert.equal(m.tokens.tracked, 1);
  assert.equal(m.tokens.perPrompt.context, 50000, 'averaged over prompts that reported tokens');
  assert.equal(m.tokens.ioRatio, 0.5);
});

test('token rates price input, output and context when an agreement uses them', () => {
  const priced = {
    ...defaultConfig(),
    tokenRates: { default: { input: 1, output: 2, context: 0 }, perModel: {} },
  };
  const period = fixture();
  // tokenCredits are stamped at log time, so recompute this one by hand:
  // 2000 input /1k * 1 + 1000 output /1k * 2 = 4 credits.
  period.sessions[1].prompts[2].tokenCredits = 4;
  const m = computeMetrics(period, priced, { now });
  assert.equal(m.burn.tokenCredits, 4);
  assert.equal(m.burn.requestCredits, 14);
  assert.equal(m.burn.credits, 18);
});

test('an empty cycle produces zeros instead of NaN', () => {
  const period = { ...fixture(), sessions: [] };
  const m = computeMetrics(period, cfg, { now });
  assert.equal(m.burn.credits, 0);
  assert.equal(m.burn.perDay, 0);
  assert.equal(m.sessions.singleRate, 0);
  assert.equal(m.promptLength.avgChars, 0);
  assert.equal(m.models.length, 0);
  assert.equal(m.burn.busiestDay, null);
});
