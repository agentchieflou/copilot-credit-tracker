import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Each test gets its own isolated data dir via CCRED_HOME. */
function useTempHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ccred-${name}-`));
  process.env.CCRED_HOME = dir;
  return dir;
}

const { loadState, savePeriod, archiveIds, loadArchived } = await import('../src/core/state.js');
const { makePeriod, cycleStartFor } = await import('../src/core/period.js');
const { defaultConfig, saveConfig } = await import('../src/core/config.js');
const { loadModelTable, resolveModel } = await import('../src/core/models.js');
const { recordPrompt, startSession, activeSession } = await import('../src/core/ledger.js');

function seedExpiredPeriod(startDate, cfg) {
  const table = loadModelTable();
  const period = makePeriod(startDate, cfg, table);
  const sonnet = resolveModel('sonnet', table);
  recordPrompt(period, cfg, { model: sonnet, note: 'old work', at: new Date(startDate.getTime() + 3600_000) });
  startSession(period, { model: sonnet, label: 'left open', at: new Date(startDate.getTime() + 7200_000) });
  savePeriod(period);
  return period;
}

test('an elapsed cycle is archived and a fresh one starts', () => {
  useTempHome('roll');
  const cfg = defaultConfig();
  saveConfig(cfg);
  const old = seedExpiredPeriod(new Date(2026, 5, 1), cfg); // June

  const state = loadState({ now: new Date(2026, 7, 20) }); // August

  assert.notEqual(state.period.id, old.id, 'a new cycle should be live');
  assert.equal(state.period.id, '2026-08');
  assert.equal(state.period.sessions.length, 0, 'the new cycle starts empty');
  assert.ok(state.rolled.includes('2026-06'), 'June should have rolled over');

  const archived = loadArchived('2026-06');
  assert.ok(archived, 'last cycle must be saved, not discarded');
  assert.equal(archived.sessions.length, 2);
  assert.equal(archived.sessions[0].prompts.length, 1);
  assert.ok(archived.closedAt, 'archived cycles are stamped closed');
});

test('a session still open at the reset is closed at the boundary, not carried over', () => {
  useTempHome('open');
  const cfg = defaultConfig();
  saveConfig(cfg);
  seedExpiredPeriod(new Date(2026, 5, 1), cfg);

  const state = loadState({ now: new Date(2026, 6, 5) });
  assert.equal(activeSession(state.period), null, 'no session should leak into the new cycle');

  const archived = loadArchived('2026-06');
  const leftOpen = archived.sessions.find((s) => s.label === 'left open');
  assert.equal(leftOpen.status, 'closed');
  assert.equal(leftOpen.closeReason, 'period-rollover');
  assert.equal(new Date(leftOpen.endedAt).getTime(), new Date(archived.end).getTime());
});

test('several missed cycles all roll over, each archived separately', () => {
  useTempHome('multi');
  const cfg = defaultConfig();
  saveConfig(cfg);
  seedExpiredPeriod(new Date(2026, 0, 1), cfg); // January

  const state = loadState({ now: new Date(2026, 4, 10) }); // May
  assert.equal(state.period.id, '2026-05');
  // Only January had activity, so only January is written; the empty months in
  // between are simply absent.
  assert.deepEqual(archiveIds(), ['2026-01']);
  assert.equal(loadArchived('2026-01').sessions.length, 2);
});

test('changing the reset day mid-cycle re-anchors without losing entries', () => {
  useTempHome('reanchor');
  const cfg = defaultConfig();
  saveConfig(cfg);
  const table = loadModelTable();
  const period = makePeriod(cycleStartFor(new Date(2026, 7, 20), 1), cfg, table);
  recordPrompt(period, cfg, { model: resolveModel('opus', table), at: new Date(2026, 7, 20) });
  savePeriod(period);

  const moved = { ...defaultConfig(), cycleResetDay: 14 };
  saveConfig(moved);

  const state = loadState({ now: new Date(2026, 7, 20) });
  assert.equal(state.period.resetDay, 14);
  assert.equal(new Date(state.period.start).getDate(), 14);
  assert.equal(state.period.sessions.length, 1, 'the cycle kept its entries');
});

test('a plan change applies to the live cycle immediately', () => {
  useTempHome('plan');
  saveConfig(defaultConfig());
  const first = loadState({ now: new Date(2026, 7, 20) });
  assert.equal(first.period.allowance, 300);

  saveConfig({ ...defaultConfig(), plan: 'pro+' });
  const second = loadState({ now: new Date(2026, 7, 20) });
  assert.equal(second.period.allowance, 1500);
  assert.equal(second.period.id, first.period.id, 'same cycle, new cap');
});

test('state survives a fresh process reading the same data dir', () => {
  const dir = useTempHome('persist');
  saveConfig(defaultConfig());
  const table = loadModelTable();
  const a = loadState({ now: new Date(2026, 7, 20) });
  recordPrompt(a.period, a.cfg, { model: resolveModel('sonnet', table), note: 'session one' });
  savePeriod(a.period);

  // Simulate a new shell: nothing in memory, only what is on disk.
  assert.ok(fs.existsSync(path.join(dir, 'current.json')));
  const b = loadState({ now: new Date(2026, 7, 20) });
  assert.equal(b.period.sessions.length, 1);
  assert.equal(b.period.sessions[0].prompts[0].note, 'session one');
});
