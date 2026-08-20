import { planAllowance, planLabel, loadModelTable } from './models.js';

export const MS_PER_DAY = 86400000;

export function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** A reset day of 31 has to mean "28th" in February. */
export function clampDay(year, monthIndex, day) {
  const d = Math.min(Math.max(Math.trunc(day) || 1, 1), 31);
  return Math.min(d, daysInMonth(year, monthIndex));
}

export function normalizeResetDay(day) {
  const n = Math.trunc(Number(day));
  if (!Number.isFinite(n) || n < 1 || n > 31) return 1;
  return n;
}

/** Local midnight of the most recent cycle boundary at or before `date`. */
export function cycleStartFor(date, resetDay) {
  const rd = normalizeResetDay(resetDay);
  let year = date.getFullYear();
  let month = date.getMonth();
  let start = new Date(year, month, clampDay(year, month, rd), 0, 0, 0, 0);
  if (date < start) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    start = new Date(year, month, clampDay(year, month, rd), 0, 0, 0, 0);
  }
  return start;
}

/** Exclusive end of the cycle that begins at `start`. */
export function cycleEndFor(start, resetDay) {
  const rd = normalizeResetDay(resetDay);
  let year = start.getFullYear();
  let month = start.getMonth() + 1;
  if (month > 11) {
    month = 0;
    year += 1;
  }
  return new Date(year, month, clampDay(year, month, rd), 0, 0, 0, 0);
}

/**
 * One cycle begins in each calendar month whatever the reset day is, so the
 * start month is a stable unique id. Archives are named after it.
 */
export function periodIdFor(start) {
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
}

export function makePeriod(startDate, cfg, table = loadModelTable()) {
  const start = new Date(startDate);
  const end = cycleEndFor(start, cfg.cycleResetDay);
  return {
    schema: 1,
    id: periodIdFor(start),
    start: start.toISOString(),
    end: end.toISOString(),
    resetDay: normalizeResetDay(cfg.cycleResetDay),
    plan: cfg.plan,
    planLabel: planLabel(cfg, table),
    allowance: planAllowance(cfg, table),
    createdAt: new Date().toISOString(),
    closedAt: null,
    sessions: [],
    sync: null,
    notes: [],
  };
}

export function currentPeriodFor(date, cfg, table) {
  return makePeriod(cycleStartFor(date, cfg.cycleResetDay), cfg, table);
}

export function isExpired(period, now = new Date()) {
  return now.getTime() >= new Date(period.end).getTime();
}

export function periodProgress(period, now = new Date()) {
  const start = new Date(period.start).getTime();
  const end = new Date(period.end).getTime();
  const clampedNow = Math.min(Math.max(now.getTime(), start), end);
  const totalMs = end - start;
  const elapsedMs = clampedNow - start;
  const daysTotal = totalMs / MS_PER_DAY;
  const daysElapsed = elapsedMs / MS_PER_DAY;
  return {
    start: new Date(start),
    end: new Date(end),
    daysTotal,
    daysElapsed,
    daysRemaining: Math.max(daysTotal - daysElapsed, 0),
    fraction: totalMs > 0 ? elapsedMs / totalMs : 1,
    /** Whole calendar days left, the number a human budgets against. */
    daysLeftWhole: Math.max(Math.ceil((end - Math.min(now.getTime(), end)) / MS_PER_DAY), 0),
  };
}
