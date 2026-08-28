/**
 * Read what the Copilot CLI already knows.
 *
 * The billing API is an owner / billing-manager surface, which is the wrong
 * place to ask - a seat holder can see their own usage in the CLI without any
 * of those rights, because the CLI keeps it locally. Every session writes an
 * event log under `~/.copilot/session-state/<id>/events.jsonl`, and its
 * `session.shutdown` event carries the totals:
 *
 *   totalNanoAiu          AI credits consumed, in billionths of an AI unit
 *   totalPremiumRequests  the same spend counted the legacy way
 *   currentTokens, systemTokens, conversationTokens, toolDefinitionsTokens
 *   modelMetrics          per-model breakdown
 *   codeChanges           lines added / removed / files touched
 *
 * That is strictly more than the billing API returns - it has real token
 * counts, which billing does not - and it needs no token, no network and no
 * permission beyond reading your own home directory.
 *
 * Verified against Copilot CLI 1.0.81. Everything here is defensive: fields are
 * read if present and skipped if not, so a CLI that changes shape degrades to
 * "nothing to harvest" instead of writing wrong numbers into the ledger.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { round4 } from './models.js';

/** AI credits are reported in billionths, to keep the transport integral. */
export const NANO_PER_AIU = 1e9;

export function nanoToAiu(nano) {
  const n = Number(nano);
  return Number.isFinite(n) ? round4(n / NANO_PER_AIU) : 0;
}

/** `COPILOT_HOME` mirrors how the CLI itself can be relocated. */
export function copilotHome() {
  if (process.env.CCRED_COPILOT_HOME) return path.resolve(process.env.CCRED_COPILOT_HOME);
  if (process.env.COPILOT_HOME) return path.resolve(process.env.COPILOT_HOME);
  return path.join(os.homedir(), '.copilot');
}

export function sessionStateDir(home = copilotHome()) {
  return path.join(home, 'session-state');
}

/** Session directories, oldest first. Missing directory means nothing to read. */
export function listSessionIds(home = copilotHome()) {
  try {
    return fs
      .readdirSync(sessionStateDir(home), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * One event per line. A session still running has a partially written last
 * line, so a trailing unparseable line is expected rather than exceptional.
 */
export function readEvents(sessionId, home = copilotHome()) {
  const file = path.join(sessionStateDir(home), sessionId, 'events.jsonl');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* a half-written final line from a live session */
    }
  }
  return events;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Turn counting is deliberately conservative. The shutdown event gives totals
 * but not how many exchanges produced them, and a multi-turn session recorded
 * as one prompt would quietly inflate the one-and-done rate - the single
 * statistic this tool exists to report honestly. So turns are counted only
 * from events that clearly represent a model exchange, and when none are found
 * the count is reported as unknown rather than guessed at 1.
 */
const TURN_EVENT = /(^|\.)(user_message|user_prompt|prompt|turn|request|model_call|completion)(\.|$)/i;

export function countTurns(events) {
  const turns = events.filter((e) => TURN_EVENT.test(String(e.type || ''))).length;
  return turns > 0 ? turns : null;
}

/** Per-model totals, when the CLI recorded them. Shape is read leniently. */
export function readModelMetrics(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .map(([id, m]) => ({
      id: String(id),
      aiu: nanoToAiu(m?.totalNanoAiu ?? m?.nanoAiu),
      premiumRequests: round4(num(m?.totalPremiumRequests ?? m?.premiumRequests)),
      tokens: {
        input: num(m?.inputTokens ?? m?.totalInputTokens),
        output: num(m?.outputTokens ?? m?.totalOutputTokens),
        cacheRead: num(m?.cacheReadTokens ?? m?.totalCacheReadTokens),
        cacheWrite: num(m?.cacheWriteTokens ?? m?.totalCacheWriteTokens),
        reasoning: num(m?.reasoningTokens ?? m?.totalReasoningTokens),
      },
      calls: num(m?.calls ?? m?.requests) || null,
    }))
    .filter((m) => m.id);
}

/**
 * Fold one session's events into the facts worth keeping. Returns null for a
 * session that never shut down cleanly - its totals were never written, and
 * inventing them would be worse than leaving it out.
 */
export function summarizeSession(sessionId, events) {
  const start = events.find((e) => e.type === 'session.start');
  const shutdown = events.find((e) => e.type === 'session.shutdown');
  if (!shutdown) return null;

  const d = shutdown.data || {};
  const s = start?.data || {};
  const startedMs = num(d.sessionStartTime) || (s.startTime ? Date.parse(s.startTime) : NaN);
  const startedAt = Number.isFinite(startedMs) && startedMs > 0 ? new Date(startedMs) : null;
  const endedAt = shutdown.timestamp ? new Date(shutdown.timestamp) : startedAt;
  if (!startedAt || Number.isNaN(startedAt.getTime())) return null;

  // The last model actually in use; the initial resolution is the fallback.
  const modelChanges = events.filter((e) => e.type === 'session.model_change');
  const last = modelChanges[modelChanges.length - 1];
  const models = readModelMetrics(d.modelMetrics);

  return {
    id: sessionId,
    startedAt,
    endedAt: endedAt && !Number.isNaN(endedAt.getTime()) ? endedAt : startedAt,
    model: models.length === 1 ? models[0].id : last?.data?.newModel || s.model || null,
    models,
    aiu: nanoToAiu(d.totalNanoAiu),
    premiumRequests: round4(num(d.totalPremiumRequests)),
    tokens: {
      // `currentTokens` is the context window at exit, not cumulative spend, so
      // it is kept separate from the parts that do accumulate.
      context: num(d.currentTokens),
      system: num(d.systemTokens),
      conversation: num(d.conversationTokens),
      toolDefinitions: num(d.toolDefinitionsTokens),
    },
    turns: countTurns(events),
    apiDurationMs: num(d.totalApiDurationMs),
    codeChanges: {
      linesAdded: num(d.codeChanges?.linesAdded),
      linesRemoved: num(d.codeChanges?.linesRemoved),
      filesModified: Array.isArray(d.codeChanges?.filesModified) ? d.codeChanges.filesModified.length : 0,
    },
    cwd: s.context?.cwd || null,
    branch: s.context?.branch || null,
    copilotVersion: s.copilotVersion || null,
    shutdownType: d.shutdownType || null,
  };
}

/** Every cleanly finished session the CLI has left on this machine. */
export function readLocalSessions({ home = copilotHome() } = {}) {
  const sessions = [];
  const skipped = { unfinished: 0, unreadable: 0 };
  for (const id of listSessionIds(home)) {
    let events;
    try {
      events = readEvents(id, home);
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    const summary = summarizeSession(id, events);
    if (!summary) {
      skipped.unfinished += 1;
      continue;
    }
    sessions.push(summary);
  }
  sessions.sort((a, b) => a.startedAt - b.startedAt);
  return { sessions, skipped, home };
}

/** Did this session cost anything? A no-op session is not worth a ledger entry. */
export function hasSpend(session) {
  return session.aiu > 0 || session.premiumRequests > 0;
}
