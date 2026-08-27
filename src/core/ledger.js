import { randomUUID } from 'node:crypto';
import { requestCredits, round4 } from './models.js';

export function newId(prefix) {
  return `${prefix}_${randomUUID().split('-')[0]}`;
}

/**
 * Where an entry came from. Prompts you logged carry the full picture - session
 * shape, prompt length, outcome. Entries backfilled from GitHub's billing data
 * carry only what GitHub reports: a day, a model and a request count. Both are
 * real spend, so both count toward burn; only logged ones can honestly speak to
 * session shape or prompt length, and the metrics engine keeps them apart.
 */
export const ORIGIN_IMPORT = 'import';

export function isImported(entry) {
  return entry?.origin === ORIGIN_IMPORT;
}

/** Sessions you actually logged, i.e. everything that is not a backfill. */
export function loggedSessions(period) {
  return period.sessions.filter((s) => !isImported(s));
}

export function importedSessions(period) {
  return period.sessions.filter(isImported);
}

export function openSessions(period) {
  return period.sessions.filter((s) => s.status === 'open');
}

export function activeSession(period) {
  const open = openSessions(period);
  return open.length ? open[open.length - 1] : null;
}

export function findSession(period, id) {
  return period.sessions.find((s) => s.id === id || s.id.endsWith(id)) || null;
}

export function startSession(period, { model, label = null, tags = [], at = new Date() } = {}) {
  const session = {
    id: newId('s'),
    label,
    model: model ? model.id : null,
    tags,
    startedAt: at.toISOString(),
    endedAt: null,
    status: 'open',
    outcome: null,
    prompts: [],
  };
  period.sessions.push(session);
  return session;
}

export function closeSession(session, { outcome = null, at = new Date(), reason = null } = {}) {
  session.status = 'closed';
  session.endedAt = at.toISOString();
  if (outcome) session.outcome = outcome;
  if (reason) session.closeReason = reason;
  return session;
}

/** Credits charged for token volume, when an agreement prices tokens (0 by default). */
export function tokenCredits(tokens, model, cfg) {
  const rates = { ...(cfg.tokenRates?.default || {}), ...((cfg.tokenRates?.perModel || {})[model.id] || {}) };
  const per1k = (n, rate) => ((Number(n) || 0) / 1000) * (Number(rate) || 0);
  return round4(
    per1k(tokens.input, rates.input) + per1k(tokens.output, rates.output) + per1k(tokens.context, rates.context),
  );
}

export function makePrompt({ model, cfg, count = 1, chars = null, words = null, tokens = {}, note = null, multiplier = null, at = new Date() }) {
  const mult = multiplier == null ? Number(model.multiplier) : Number(multiplier);
  const tok = {
    input: Number(tokens.input) || 0,
    output: Number(tokens.output) || 0,
    context: Number(tokens.context) || 0,
  };
  return {
    id: newId('p'),
    at: at.toISOString(),
    model: model.id,
    count,
    multiplier: mult,
    credits: round4(requestCredits({ multiplier: mult }, count)),
    chars: chars == null ? null : Math.max(0, Math.trunc(chars)),
    words: words == null ? null : Math.max(0, Math.trunc(words)),
    tokens: tok,
    tokenCredits: tokenCredits(tok, model, cfg),
    note,
  };
}

/**
 * Attach a prompt to the right session: the open one if it is still warm,
 * otherwise a fresh session. Returns { session, prompt, startedNew }.
 */
export function recordPrompt(period, cfg, opts) {
  const at = opts.at || new Date();
  let session = activeSession(period);
  let startedNew = false;

  if (session) {
    const last = session.prompts.length
      ? new Date(session.prompts[session.prompts.length - 1].at)
      : new Date(session.startedAt);
    const idleMin = (at.getTime() - last.getTime()) / 60000;
    const limit = Number(cfg.session?.idleCloseMinutes ?? 45);
    if (limit > 0 && idleMin > limit) {
      closeSession(session, { at: last, reason: 'idle-timeout' });
      session = null;
    }
  }

  if (!session) {
    session = startSession(period, { model: opts.model, label: opts.label ?? opts.note ?? null, tags: opts.tags || [], at });
    startedNew = true;
  }

  const prompt = makePrompt({ ...opts, cfg, at });
  session.prompts.push(prompt);
  if (!session.model) session.model = prompt.model;
  if (!session.label && opts.note) session.label = opts.note;
  return { session, prompt, startedNew };
}

/** Remove the most recent prompt anywhere in the period. */
export function undoLastPrompt(period) {
  let target = null;
  for (const session of period.sessions) {
    for (const prompt of session.prompts) {
      if (!target || new Date(prompt.at) >= new Date(target.prompt.at)) target = { session, prompt };
    }
  }
  if (!target) return null;
  target.session.prompts = target.session.prompts.filter((p) => p.id !== target.prompt.id);
  const removedSession = target.session.prompts.length === 0;
  if (removedSession) period.sessions = period.sessions.filter((s) => s.id !== target.session.id);
  return { ...target, removedSession };
}

export function allPrompts(period) {
  return period.sessions.flatMap((s) => s.prompts.map((p) => ({ ...p, sessionId: s.id })));
}

export function totalCredits(period) {
  return round4(allPrompts(period).reduce((sum, p) => sum + p.credits + (p.tokenCredits || 0), 0));
}
