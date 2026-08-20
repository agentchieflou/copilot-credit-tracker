import { paths } from './paths.js';
import { readJson, writeJson, listArchive } from './store.js';
import { loadConfig } from './config.js';
import { loadModelTable, planAllowance, planLabel } from './models.js';
import { cycleStartFor, makePeriod, periodIdFor, isExpired } from './period.js';
import { openSessions, closeSession } from './ledger.js';

const MAX_ROLLOVERS = 600; // ~50 years; a guard, not a real limit

export function savePeriod(period) {
  writeJson(paths().currentFile, period);
  return period;
}

export function writeArchived(period) {
  writeJson(paths().archiveFile(period.id), period);
  return period;
}

export function loadArchived(periodId) {
  return readJson(paths().archiveFile(periodId), null);
}

export function archiveIds() {
  return listArchive(paths().archiveDir);
}

/**
 * Persist a finished cycle. Empty cycles are not written: an absent archive
 * simply means nothing was logged that month.
 */
export function archivePeriod(period) {
  const hasContent = period.sessions.length > 0 || period.sync;
  if (!hasContent) return null;
  period.closedAt = new Date().toISOString();

  const file = paths().archiveFile(period.id);
  const existing = readJson(file, null);
  if (existing) {
    const known = new Set(existing.sessions.map((s) => s.id));
    existing.sessions.push(...period.sessions.filter((s) => !known.has(s.id)));
    existing.sync = period.sync || existing.sync;
    existing.closedAt = period.closedAt;
    writeJson(file, existing);
    return existing;
  }
  writeJson(file, period);
  return period;
}

/**
 * Load the live cycle, rolling over and archiving as many elapsed cycles as
 * needed. Every command goes through here, so the monthly reset happens on the
 * next call after the reset date with no cron, daemon or user action.
 */
export function loadState({ now = new Date(), persist = true } = {}) {
  const cfg = loadConfig();
  const table = loadModelTable();
  const p = paths();
  let period = readJson(p.currentFile, null);
  const rolled = [];

  if (!period) {
    period = makePeriod(cycleStartFor(now, cfg.cycleResetDay), cfg, table);
    if (persist) savePeriod(period);
    return { cfg, table, period, rolled, fresh: true };
  }

  // The reset day changed in config: re-anchor without losing this cycle's data.
  if (period.resetDay !== undefined && period.resetDay !== cfg.cycleResetDay) {
    const anchored = makePeriod(cycleStartFor(now, cfg.cycleResetDay), cfg, table);
    if (anchored.id === period.id) {
      period.start = anchored.start;
      period.end = anchored.end;
      period.resetDay = anchored.resetDay;
    } else {
      for (const s of openSessions(period)) closeSession(s, { reason: 'cycle-reanchored' });
      archivePeriod(period);
      rolled.push(period.id);
      period = anchored;
    }
  }

  let guard = 0;
  while (isExpired(period, now) && guard++ < MAX_ROLLOVERS) {
    const boundary = new Date(period.end);
    for (const s of openSessions(period)) closeSession(s, { at: boundary, reason: 'period-rollover' });
    archivePeriod(period);
    rolled.push(period.id);
    period = makePeriod(boundary, cfg, table);
  }

  // Plan changes apply to the live cycle immediately.
  period.plan = cfg.plan;
  period.planLabel = planLabel(cfg, table);
  period.allowance = planAllowance(cfg, table);
  if (period.id !== periodIdFor(new Date(period.start))) period.id = periodIdFor(new Date(period.start));

  if (persist) savePeriod(period);
  return { cfg, table, period, rolled, fresh: false };
}

/** Resolve a period id like "2026-07", "last" or "current" to a period object. */
export function resolvePeriod(ref, state) {
  if (!ref || ref === 'current' || ref === 'now') return state.period;
  if (ref === 'last' || ref === 'previous') {
    const ids = archiveIds().filter((id) => id !== state.period.id);
    if (!ids.length) return null;
    return loadArchived(ids[ids.length - 1]);
  }
  if (ref === state.period.id) return state.period;
  return loadArchived(ref);
}
