import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampDay,
  cycleStartFor,
  cycleEndFor,
  periodIdFor,
  periodProgress,
  normalizeResetDay,
} from '../src/core/period.js';

test('clampDay pulls a 31st reset back to the last day of a short month', () => {
  assert.equal(clampDay(2026, 1, 31), 28); // Feb 2026
  assert.equal(clampDay(2024, 1, 31), 29); // Feb 2024, leap year
  assert.equal(clampDay(2026, 3, 31), 30); // April
  assert.equal(clampDay(2026, 0, 31), 31); // January
});

test('normalizeResetDay rejects nonsense and falls back to the 1st', () => {
  assert.equal(normalizeResetDay(0), 1);
  assert.equal(normalizeResetDay(32), 1);
  assert.equal(normalizeResetDay('14'), 14);
  assert.equal(normalizeResetDay(undefined), 1);
});

test('a reset day of 1 gives calendar months', () => {
  const start = cycleStartFor(new Date(2026, 7, 20), 1);
  assert.equal(start.getMonth(), 7);
  assert.equal(start.getDate(), 1);
  const end = cycleEndFor(start, 1);
  assert.equal(end.getMonth(), 8);
  assert.equal(end.getDate(), 1);
});

test('a mid-month reset day anchors on the renewal date', () => {
  // Before the 14th, the live cycle still belongs to the previous month.
  const early = cycleStartFor(new Date(2026, 7, 3), 14);
  assert.equal(early.getMonth(), 6);
  assert.equal(early.getDate(), 14);

  const late = cycleStartFor(new Date(2026, 7, 20), 14);
  assert.equal(late.getMonth(), 7);
  assert.equal(late.getDate(), 14);

  // Exactly on the reset day the new cycle has already begun.
  const onDay = cycleStartFor(new Date(2026, 7, 14, 0, 0, 0), 14);
  assert.equal(onDay.getMonth(), 7);
});

test('a 31st reset day rolls through February without losing a cycle', () => {
  const jan = cycleStartFor(new Date(2026, 0, 31), 31);
  assert.equal(jan.getDate(), 31);
  const feb = cycleEndFor(jan, 31);
  assert.equal(feb.getMonth(), 1);
  assert.equal(feb.getDate(), 28);
  const mar = cycleEndFor(feb, 31);
  assert.equal(mar.getMonth(), 2);
  assert.equal(mar.getDate(), 31);
});

test('cycle ids stay unique because exactly one cycle starts per month', () => {
  const ids = new Set();
  let cursor = cycleStartFor(new Date(2026, 0, 5), 31);
  for (let i = 0; i < 24; i += 1) {
    ids.add(periodIdFor(cursor));
    cursor = cycleEndFor(cursor, 31);
  }
  assert.equal(ids.size, 24);
});

test('periodProgress clamps outside the window', () => {
  const period = {
    start: new Date(2026, 7, 1).toISOString(),
    end: new Date(2026, 8, 1).toISOString(),
  };
  const before = periodProgress(period, new Date(2026, 6, 1));
  assert.equal(before.fraction, 0);
  const after = periodProgress(period, new Date(2026, 9, 1));
  assert.equal(after.fraction, 1);
  assert.equal(after.daysLeftWhole, 0);
  const mid = periodProgress(period, new Date(2026, 7, 16, 12));
  assert.ok(mid.fraction > 0.49 && mid.fraction < 0.51, `mid fraction was ${mid.fraction}`);
});
