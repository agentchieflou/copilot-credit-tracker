import { periodProgress, MS_PER_DAY } from './period.js';
import { allPrompts, isDerived, loggedSessions } from './ledger.js';
import { round4 } from './models.js';

export const LENGTH_BUCKETS = [
  { label: 'terse (<200 ch)', min: 0, max: 200 },
  { label: 'short (200-600)', min: 200, max: 600 },
  { label: 'detailed (600-1500)', min: 600, max: 1500 },
  { label: 'long (1500+)', min: 1500, max: Infinity },
];

export const SESSION_BUCKETS = [
  { label: '1 prompt', min: 1, max: 1 },
  { label: '2 prompts', min: 2, max: 2 },
  { label: '3-5 prompts', min: 3, max: 5 },
  { label: '6-10 prompts', min: 6, max: 10 },
  { label: '11+ prompts', min: 11, max: Infinity },
];

export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(nums, p) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

const sum = (arr, fn) => round4(arr.reduce((a, x) => a + (fn(x) || 0), 0));
const avg = (arr, fn) => (arr.length ? round4(sum(arr, fn) / arr.length) : 0);
const promptCredits = (p) => (p.credits || 0) + (p.tokenCredits || 0);
const sessionCredits = (s) => sum(s.prompts, promptCredits);

export function localDateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function computeMetrics(period, cfg, { now = new Date(), table = null } = {}) {
  const prompts = allPrompts(period);
  const sessions = period.sessions;
  const progress = periodProgress(period, now);
  const allowance = Number(period.allowance) || 0;

  // Spend backfilled from GitHub's billing data is real money and belongs in
  // the burn numbers, but it carries no session structure and no prompt text.
  // Everything about session shape or prompt length is therefore computed over
  // logged entries only, so a backfilled month cannot invent a habit.
  const imported = prompts.filter(isDerived);
  const logged = prompts.filter((p) => !isDerived(p));
  const loggedWithPrompts = loggedSessions(period).filter((s) => s.prompts.length > 0);

  const reqCredits = sum(prompts, (p) => p.credits);
  const tokCredits = sum(prompts, (p) => p.tokenCredits);
  const credits = round4(reqCredits + tokCredits);
  const importedCredits = sum(imported, promptCredits);
  const loggedCredits = round4(credits - importedCredits);
  const aiu = sum(prompts, (p) => p.aiu);
  const remaining = allowance ? round4(Math.max(allowance - credits, 0)) : null;
  const over = allowance ? round4(Math.max(credits - allowance, 0)) : 0;

  // Guard against a divide-by-zero in the first minutes of a new cycle.
  const daysElapsed = Math.max(progress.daysElapsed, 1 / 24);
  const perDay = round4(credits / daysElapsed);
  const projected = round4(progress.fraction > 0 ? credits / progress.fraction : credits);
  const expectedByNow = allowance ? round4(allowance * progress.fraction) : null;
  const paceDelta = expectedByNow == null ? null : round4(credits - expectedByNow);
  let pace = 'n/a';
  if (expectedByNow != null) {
    const tolerance = Math.max(allowance * 0.05, 1);
    pace = paceDelta > tolerance ? 'over' : paceDelta < -tolerance ? 'under' : 'on-track';
  }
  const safeDaily = remaining == null ? null : round4(remaining / Math.max(progress.daysLeftWhole, 1));
  let exhaustion = null;
  if (remaining != null && remaining > 0 && perDay > 0) {
    const when = new Date(now.getTime() + (remaining / perDay) * MS_PER_DAY);
    exhaustion = when < progress.end ? when.toISOString() : null;
  }

  // ---- session shape -------------------------------------------------------
  const withPrompts = loggedWithPrompts;
  const counts = withPrompts.map((s) => s.prompts.length);
  const single = withPrompts.filter((s) => s.prompts.length === 1);
  const multi = withPrompts.filter((s) => s.prompts.length > 1);
  const followUpCredits = sum(withPrompts, (s) => sum(s.prompts.slice(1), promptCredits));

  const durations = withPrompts
    .map((s) => {
      const start = new Date(s.startedAt).getTime();
      const last = new Date(s.prompts[s.prompts.length - 1].at).getTime();
      const endMs = s.endedAt ? new Date(s.endedAt).getTime() : last;
      return Math.max(endMs, last) - start;
    })
    .filter((ms) => ms >= 0);

  const sessionStats = {
    total: withPrompts.length,
    open: sessions.filter((s) => s.status === 'open').length,
    /** Backfilled day-and-model rows, which are deliberately not sessions. */
    importedEntries: imported.length,
    single: single.length,
    multi: multi.length,
    singleRate: withPrompts.length ? round4(single.length / withPrompts.length) : 0,
    avgPrompts: withPrompts.length ? round4(logged.length / withPrompts.length) : 0,
    medianPrompts: median(counts),
    maxPrompts: counts.length ? Math.max(...counts) : 0,
    singleCredits: sum(single, sessionCredits),
    multiCredits: sum(multi, sessionCredits),
    followUpCredits,
    // Share of spend that went to prompts after the opener - the re-prompt tax.
    // Measured against logged spend: a backfill has no openers to be after.
    followUpShare: loggedCredits ? round4(followUpCredits / loggedCredits) : 0,
    avgCreditsPerSession: avg(withPrompts, sessionCredits),
    avgDurationMin: durations.length
      ? round4(durations.reduce((a, b) => a + b, 0) / durations.length / 60000)
      : 0,
    distribution: SESSION_BUCKETS.map((b) => {
      const inBucket = withPrompts.filter((s) => s.prompts.length >= b.min && s.prompts.length <= b.max);
      return {
        label: b.label,
        count: inBucket.length,
        share: withPrompts.length ? round4(inBucket.length / withPrompts.length) : 0,
        credits: sum(inBucket, sessionCredits),
      };
    }),
  };

  // ---- per model -----------------------------------------------------------
  const modelIds = [...new Set(prompts.map((p) => p.model))];
  const models = modelIds
    .map((id) => {
      const mine = prompts.filter((p) => p.model === id);
      const mineLogged = logged.filter((p) => p.model === id);
      const mySessions = withPrompts.filter((s) => s.prompts.some((p) => p.model === id));
      // Sessions run entirely on this model are the only fair basis for
      // "how many prompts does it take to get there".
      const soleSessions = withPrompts.filter((s) => s.prompts.every((p) => p.model === id));
      const chars = mine.map((p) => p.chars).filter((c) => typeof c === 'number');
      const c = sum(mine, promptCredits);
      const tokens = {
        input: sum(mine, (p) => p.tokens?.input),
        output: sum(mine, (p) => p.tokens?.output),
        context: sum(mine, (p) => p.tokens?.context),
      };
      const meta = table?.models?.find((m) => m.id === id);
      return {
        id,
        label: meta?.label || id,
        multiplier: mine[0]?.multiplier ?? meta?.multiplier ?? 0,
        prompts: mine.length,
        loggedPrompts: mineLogged.length,
        importedCredits: sum(mine.filter(isDerived), promptCredits),
        aiu: sum(mine, (p) => p.aiu),
        requests: sum(mine, (p) => p.count),
        credits: c,
        requestCredits: sum(mine, (p) => p.credits),
        tokenCredits: sum(mine, (p) => p.tokenCredits),
        share: credits ? round4(c / credits) : 0,
        sessions: mySessions.length,
        soleSessions: soleSessions.length,
        avgPromptsPerSession: soleSessions.length
          ? round4(sum(soleSessions, (s) => s.prompts.length) / soleSessions.length)
          : mySessions.length
            ? round4(mineLogged.length / mySessions.length)
            : 0,
        singleRate: soleSessions.length
          ? round4(soleSessions.filter((s) => s.prompts.length === 1).length / soleSessions.length)
          : 0,
        creditsPerSession: soleSessions.length
          ? round4(sum(soleSessions, sessionCredits) / soleSessions.length)
          : 0,
        avgChars: chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : null,
        medianChars: chars.length ? Math.round(median(chars)) : null,
        tokens,
        tokensPerCredit: c > 0 ? Math.round((tokens.input + tokens.output) / c) : 0,
        avgContext: mine.length ? Math.round(tokens.context / mine.length) : 0,
      };
    })
    .sort((a, b) => b.credits - a.credits || b.prompts - a.prompts);

  // ---- prompt length -------------------------------------------------------
  const charList = logged.map((p) => p.chars).filter((c) => typeof c === 'number');
  const wordList = logged.map((p) => p.words).filter((w) => typeof w === 'number');
  const lengthBuckets = LENGTH_BUCKETS.map((b) => {
    const inBucket = logged.filter(
      (p) => typeof p.chars === 'number' && p.chars >= b.min && p.chars < b.max,
    );
    // Bucket sessions by their OPENING prompt: does a longer opener buy fewer follow-ups?
    const openers = withPrompts.filter((s) => {
      const first = s.prompts[0];
      return typeof first.chars === 'number' && first.chars >= b.min && first.chars < b.max;
    });
    return {
      label: b.label,
      prompts: inBucket.length,
      credits: sum(inBucket, promptCredits),
      openerSessions: openers.length,
      avgFollowUps: openers.length ? round4(sum(openers, (s) => s.prompts.length - 1) / openers.length) : 0,
      avgSessionCredits: avg(openers, sessionCredits),
    };
  });

  // ---- token dimensions ----------------------------------------------------
  const tokens = {
    input: sum(prompts, (p) => p.tokens?.input),
    output: sum(prompts, (p) => p.tokens?.output),
    context: sum(prompts, (p) => p.tokens?.context),
  };
  tokens.total = round4(tokens.input + tokens.output + tokens.context);
  const tokenPrompts = prompts.filter(
    (p) => (p.tokens?.input || 0) + (p.tokens?.output || 0) + (p.tokens?.context || 0) > 0,
  );
  tokens.tracked = tokenPrompts.length;
  tokens.coverage = prompts.length ? round4(tokenPrompts.length / prompts.length) : 0;
  tokens.perPrompt = {
    input: tokenPrompts.length ? Math.round(tokens.input / tokenPrompts.length) : 0,
    output: tokenPrompts.length ? Math.round(tokens.output / tokenPrompts.length) : 0,
    context: tokenPrompts.length ? Math.round(tokens.context / tokenPrompts.length) : 0,
  };
  tokens.ioRatio = tokens.input > 0 ? round4(tokens.output / tokens.input) : 0;

  // ---- daily ---------------------------------------------------------------
  const dailyMap = new Map();
  for (const p of prompts) {
    const key = localDateKey(p.at);
    const row = dailyMap.get(key) || { date: key, credits: 0, prompts: 0, requests: 0, imported: 0, opening: 0 };
    row.credits = round4(row.credits + promptCredits(p));
    row.requests = round4(row.requests + (p.count || 0));
    if (isDerived(p)) {
      row.imported = round4(row.imported + promptCredits(p));
      if (p.source === 'manual') row.opening = round4(row.opening + promptCredits(p));
    } else {
      row.prompts += 1;
    }
    dailyMap.set(key, row);
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  // An opening balance sits on the first day of the cycle by construction, so
  // it would win "busiest day" every time without meaning anything by it.
  const workDays = daily.filter((d) => round4(d.credits - d.opening) > 0);

  // ---- backfill ------------------------------------------------------------
  const importedDays = [...new Set(imported.map((p) => localDateKey(p.at)))].sort();
  const importSummary = imported.length
    ? {
        credits: importedCredits,
        requests: sum(imported, (p) => p.count),
        entries: imported.length,
        days: importedDays.length,
        firstDay: importedDays[0],
        lastDay: importedDays[importedDays.length - 1],
        share: credits ? round4(importedCredits / credits) : 0,
        unattributed: sum(
          imported.filter((p) => p.model === 'copilot-premium-request'),
          promptCredits,
        ),
        sources: [...new Set(period.sessions.filter(isDerived).map((s) => s.import?.source).filter(Boolean))],
        opening: sum(imported.filter((p) => p.source === 'manual'), promptCredits),
        at: period.lastImport?.at || null,
      }
    : null;

  const rated = withPrompts.filter((s) => s.outcome);
  const solved = rated.filter((s) => s.outcome === 'solved');
  const outcomes = rated.length
    ? {
        rated: rated.length,
        solved: solved.length,
        partial: rated.filter((s) => s.outcome === 'partial').length,
        wasted: rated.filter((s) => s.outcome === 'wasted').length,
        creditsPerSolved: solved.length ? round4(sum(solved, sessionCredits) / solved.length) : 0,
        wastedCredits: sum(
          rated.filter((s) => s.outcome === 'wasted'),
          sessionCredits,
        ),
      }
    : null;

  return {
    periodId: period.id,
    plan: period.planLabel || period.plan,
    progress,
    burn: {
      // A closed cycle has no "rest of the month" left to pace against.
      complete: progress.fraction >= 1,
      credits,
      requestCredits: reqCredits,
      tokenCredits: tokCredits,
      loggedCredits,
      importedCredits,
      /**
       * AI credits, the unit the current Copilot billing platform charges in.
       * Only entries that came from a source reporting it carry a value, so a
       * ledger built purely from hand-logged premium requests reports 0 here
       * rather than a number converted out of thin air.
       */
      aiu,
      aiuPerDay: round4(aiu / Math.max(progress.daysElapsed, 1 / 24)),
      /** Prompts you logged. A backfilled day is spend, not a prompt. */
      prompts: logged.length,
      entries: prompts.length,
      requests: sum(prompts, (p) => p.count),
      allowance,
      remaining,
      over,
      pctUsed: allowance ? round4(credits / allowance) : null,
      perDay,
      projected,
      expectedByNow,
      paceDelta,
      pace,
      safeDaily,
      exhaustion,
      busiestDay: workDays.length ? workDays.reduce((a, b) => (b.credits > a.credits ? b : a)) : null,
      activeDays: daily.length,
    },
    sessions: sessionStats,
    models,
    promptLength: {
      counted: charList.length,
      coverage: logged.length ? round4(charList.length / logged.length) : 0,
      avgChars: charList.length ? Math.round(charList.reduce((a, b) => a + b, 0) / charList.length) : 0,
      medianChars: charList.length ? Math.round(median(charList)) : 0,
      p90Chars: charList.length ? Math.round(percentile(charList, 90)) : 0,
      avgWords: wordList.length ? Math.round(wordList.reduce((a, b) => a + b, 0) / wordList.length) : 0,
      buckets: lengthBuckets,
    },
    tokens,
    daily,
    outcomes,
    imported: importSummary,
    sync: period.sync || null,
  };
}

/** Month-over-month deltas for the history view. */
export function compareMetrics(current, previous) {
  if (!previous) return null;
  const delta = (a, b) => round4((a || 0) - (b || 0));
  const pct = (a, b) => (b ? round4(((a || 0) - b) / b) : null);
  return {
    credits: delta(current.burn.credits, previous.burn.credits),
    creditsPct: pct(current.burn.credits, previous.burn.credits),
    prompts: delta(current.burn.prompts, previous.burn.prompts),
    sessions: delta(current.sessions.total, previous.sessions.total),
    avgPrompts: delta(current.sessions.avgPrompts, previous.sessions.avgPrompts),
    singleRate: delta(current.sessions.singleRate, previous.sessions.singleRate),
    followUpShare: delta(current.sessions.followUpShare, previous.sessions.followUpShare),
    avgChars: delta(current.promptLength.avgChars, previous.promptLength.avgChars),
  };
}
