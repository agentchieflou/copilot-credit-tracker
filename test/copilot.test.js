import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  nanoToAiu,
  countTurns,
  summarizeSession,
  readLocalSessions,
  readModelMetrics,
  hasSpend,
  copilotHome,
} from '../src/core/copilot.js';

/**
 * Shapes here are taken from a real capture of Copilot CLI 1.0.81, not invented:
 * `session.shutdown` carries totalNanoAiu / totalPremiumRequests / the token
 * counts, and `session.start` carries the timing and workspace context.
 */
function shutdown(overrides = {}) {
  return {
    type: 'session.shutdown',
    id: 'e9',
    timestamp: '2026-08-18T14:30:00.000Z',
    data: {
      shutdownType: 'routine',
      totalPremiumRequests: 12,
      totalNanoAiu: 2_400_000_000,
      totalApiDurationMs: 42000,
      sessionStartTime: Date.parse('2026-08-18T14:00:00.000Z'),
      codeChanges: { linesAdded: 120, linesRemoved: 30, filesModified: ['a.js', 'b.js'] },
      modelMetrics: {},
      currentTokens: 52000,
      systemTokens: 7000,
      conversationTokens: 48000,
      toolDefinitionsTokens: 10000,
      ...overrides,
    },
  };
}

function start(overrides = {}) {
  return {
    type: 'session.start',
    id: 'e1',
    timestamp: '2026-08-18T14:00:00.000Z',
    data: {
      sessionId: 's1',
      copilotVersion: '1.0.81',
      startTime: '2026-08-18T14:00:00.000Z',
      context: { cwd: 'C:/work', gitRoot: 'C:/work', branch: 'main' },
      ...overrides,
    },
  };
}

const modelChange = { type: 'session.model_change', id: 'e2', timestamp: '2026-08-18T14:00:01.000Z', data: { newModel: 'claude-sonnet-4.5' } };

function tempCopilotHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ccred-copilot-${name}-`));
  return dir;
}

function writeSession(home, id, events) {
  const dir = path.join(home, 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ------------------------------------------------------------------- units

test('AI credits arrive in billionths and come back as units', () => {
  assert.equal(nanoToAiu(2_400_000_000), 2.4);
  assert.equal(nanoToAiu(0), 0);
  assert.equal(nanoToAiu(undefined), 0);
  assert.equal(nanoToAiu('9750000000'), 9.75);
});

// --------------------------------------------------------- session summary

test('a finished session yields its real credits, tokens and timing', () => {
  const s = summarizeSession('s1', [start(), modelChange, shutdown()]);
  assert.equal(s.aiu, 2.4);
  assert.equal(s.premiumRequests, 12);
  assert.equal(s.model, 'claude-sonnet-4.5');
  assert.equal(s.tokens.conversation, 48000);
  assert.equal(s.tokens.context, 52000);
  assert.equal(s.startedAt.toISOString(), '2026-08-18T14:00:00.000Z');
  assert.equal(s.endedAt.toISOString(), '2026-08-18T14:30:00.000Z');
  assert.equal(s.branch, 'main');
  assert.equal(s.codeChanges.filesModified, 2);
});

test('a session that never shut down is skipped, not guessed at', () => {
  assert.equal(summarizeSession('s1', [start(), modelChange]), null);
});

test('turn count is null when nothing recorded it, rather than 1', () => {
  const s = summarizeSession('s1', [start(), modelChange, shutdown()]);
  assert.equal(s.turns, null, 'a multi-turn session logged as one prompt would fake the one-shot rate');
});

test('turns are counted when the event stream does record them', () => {
  const turns = [1, 2, 3].map((n) => ({ type: 'session.user_message', id: `t${n}`, timestamp: '2026-08-18T14:05:00.000Z', data: {} }));
  assert.equal(countTurns([start(), modelChange, ...turns, shutdown()]), 3);
});

test('a malformed final line does not sink the whole session', () => {
  const home = tempCopilotHome('partial');
  const dir = path.join(home, 'session-state', 's1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    [JSON.stringify(start()), JSON.stringify(modelChange), JSON.stringify(shutdown()), '{"type":"session.par'].join('\n'),
  );
  const { sessions } = readLocalSessions({ home });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].aiu, 2.4);
});

test('per-model metrics are read leniently and tolerate an unknown shape', () => {
  assert.deepEqual(readModelMetrics(null), []);
  assert.deepEqual(readModelMetrics({}), []);
  const m = readModelMetrics({ 'claude-opus-4.1': { totalNanoAiu: 9_750_000_000, totalPremiumRequests: 30 } });
  assert.equal(m[0].id, 'claude-opus-4.1');
  assert.equal(m[0].aiu, 9.75);
  assert.equal(m[0].premiumRequests, 30);
  // a field the CLI does not supply must not become NaN in the ledger
  assert.equal(m[0].tokens.input, 0);
});

test('a session that made no billable call is not worth a ledger entry', () => {
  const idle = summarizeSession('s1', [start(), modelChange, shutdown({ totalPremiumRequests: 0, totalNanoAiu: 0 })]);
  assert.equal(hasSpend(idle), false);
  assert.equal(hasSpend(summarizeSession('s2', [start(), modelChange, shutdown()])), true);
});

// ------------------------------------------------------------ reading them all

test('sessions are read from disk oldest first, incomplete ones counted', () => {
  const home = tempCopilotHome('all');
  writeSession(home, 'b-second', [start({ startTime: '2026-08-20T09:00:00.000Z' }), modelChange, shutdown({ sessionStartTime: Date.parse('2026-08-20T09:00:00.000Z') })]);
  writeSession(home, 'a-first', [start(), modelChange, shutdown()]);
  writeSession(home, 'c-open', [start(), modelChange]);

  const { sessions, skipped } = readLocalSessions({ home });
  assert.equal(sessions.length, 2);
  assert.equal(skipped.unfinished, 1);
  assert.ok(sessions[0].startedAt <= sessions[1].startedAt, 'oldest first');
});

test('no Copilot CLI on the machine is an empty result, not a crash', () => {
  const home = tempCopilotHome('empty');
  const { sessions, skipped } = readLocalSessions({ home });
  assert.deepEqual(sessions, []);
  assert.equal(skipped.unfinished, 0);
});

test('the copilot home can be redirected for a work profile or a test', () => {
  const prev = process.env.CCRED_COPILOT_HOME;
  process.env.CCRED_COPILOT_HOME = 'C:/elsewhere/.copilot';
  try {
    assert.equal(copilotHome(), path.resolve('C:/elsewhere/.copilot'));
  } finally {
    if (prev === undefined) delete process.env.CCRED_COPILOT_HOME;
    else process.env.CCRED_COPILOT_HOME = prev;
  }
});
