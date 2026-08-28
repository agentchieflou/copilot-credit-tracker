import { loadState, savePeriod, resolvePeriod, writeArchived } from '../core/state.js';
import { computeMetrics } from '../core/metrics.js';
import { round4, loadModelTable } from '../core/models.js';
import { newId, ORIGIN_HARVEST, isHarvested } from '../core/ledger.js';
import { readLocalSessions, hasSpend, copilotHome } from '../core/copilot.js';
import { inferModel } from '../core/import.js';
import { c, fmtNum, fmtPct, fmtTokens, table, heading, kv, fmtDate, budgetBar, plural } from '../util/fmt.js';

/**
 * `ccred harvest` - read the Copilot CLI's own session logs.
 *
 * This is the route that needs nothing: no token, no network, no billing
 * permission. The CLI records what each session cost in
 * `~/.copilot/session-state/<id>/events.jsonl`, and it records more than the
 * billing API returns - real token counts and AI credits, not just a daily
 * request quantity.
 *
 * Sessions are keyed by the CLI's own session id, so harvesting twice adds
 * nothing and a session that ran since the last harvest is picked up on the
 * next one.
 */

function alreadyHarvested(period) {
  return new Set(period.sessions.filter(isHarvested).map((s) => s.harvest?.sessionId).filter(Boolean));
}

/** One ledger session per CLI session, carrying what the CLI actually recorded. */
function toLedgerSession(summary, table) {
  const model = summary.model ? inferModel(summary.model, table) : null;
  const modelId = model?.id || summary.model || 'copilot-premium-request';
  const multiplier = Number(model?.multiplier ?? 1);
  const tokens = {
    // The CLI reports the conversation and its overheads rather than a running
    // input/output split, so they are mapped to the dimension each belongs to
    // and nothing is invented for the ones it does not report.
    input: summary.tokens.conversation,
    output: 0,
    context: summary.tokens.context,
  };

  const prompt = {
    id: newId('p'),
    at: summary.startedAt.toISOString(),
    model: modelId,
    count: summary.turns ?? round4(summary.premiumRequests) ?? 0,
    multiplier,
    credits: round4(summary.premiumRequests),
    aiu: summary.aiu,
    chars: null,
    words: null,
    tokens,
    tokenCredits: 0,
    note: `copilot session ${summary.id.slice(0, 8)}`,
    origin: ORIGIN_HARVEST,
    source: 'copilot-cli',
  };

  return {
    id: newId('s'),
    label: `copilot ${summary.id.slice(0, 8)}${summary.branch ? ` (${summary.branch})` : ''}`,
    model: modelId,
    tags: ['harvested'],
    startedAt: summary.startedAt.toISOString(),
    endedAt: summary.endedAt.toISOString(),
    status: 'closed',
    outcome: null,
    origin: ORIGIN_HARVEST,
    import: { source: 'copilot-cli', at: new Date().toISOString() },
    harvest: {
      sessionId: summary.id,
      copilotVersion: summary.copilotVersion,
      cwd: summary.cwd,
      branch: summary.branch,
      apiDurationMs: summary.apiDurationMs,
      codeChanges: summary.codeChanges,
      models: summary.models,
      // Recorded so the metrics engine never has to guess: a session whose
      // turn count is unknown must not be counted as one-and-done.
      turnsKnown: summary.turns != null,
      rawTokens: summary.tokens,
    },
    prompts: [prompt],
  };
}

export function cmdHarvest(flags, positionals, { json }) {
  const state = loadState();
  const period = resolvePeriod(positionals[0] || null, state);
  if (!period) throw new Error(`No cycle "${positionals[0]}". Run \`ccred history\` to see what is stored.`);

  const dryRun = flags['dry-run'] === true;
  const table_ = loadModelTable();
  const { sessions, skipped, home } = readLocalSessions();

  const start = new Date(period.start);
  const end = new Date(period.end);
  const seen = alreadyHarvested(period);

  const inWindow = sessions.filter((s) => s.startedAt >= start && s.startedAt < end);
  const spent = inWindow.filter(hasSpend);
  const fresh = spent.filter((s) => !seen.has(s.id));

  const totals = {
    aiu: round4(fresh.reduce((a, s) => a + s.aiu, 0)),
    premiumRequests: round4(fresh.reduce((a, s) => a + s.premiumRequests, 0)),
    sessions: fresh.length,
    tokens: fresh.reduce((a, s) => a + s.tokens.conversation, 0),
    unknownTurns: fresh.filter((s) => s.turns == null).length,
  };

  const before = computeMetrics(period, state.cfg, { table: state.table });

  if (!dryRun && fresh.length) {
    for (const summary of fresh) period.sessions.push(toLedgerSession(summary, table_));
    period.sessions.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    period.lastHarvest = { at: new Date().toISOString(), sessions: fresh.length, aiu: totals.aiu };
    if (period.id === state.period.id) savePeriod(period);
    else writeArchived(period);
  }

  const after = computeMetrics(period, state.cfg, { table: state.table });

  if (json) {
    return {
      period: period.id,
      copilotHome: home,
      dryRun,
      found: sessions.length,
      inWindow: inWindow.length,
      alreadyHarvested: spent.length - fresh.length,
      harvested: fresh.map((s) => ({
        sessionId: s.id,
        startedAt: s.startedAt.toISOString(),
        model: s.model,
        aiu: s.aiu,
        premiumRequests: s.premiumRequests,
        turns: s.turns,
        tokens: s.tokens,
      })),
      totals,
      skipped,
      burn: after.burn,
    };
  }

  console.log(heading(`${dryRun ? 'Would harvest' : 'Harvested'} ${period.id} from the Copilot CLI`));
  console.log(kv('source', `${home} ${c.dim('(no token, no network, no billing permission)')}`));
  console.log(kv('sessions on disk', `${fmtNum(sessions.length)} finished, ${fmtNum(inWindow.length)} in this cycle`));

  if (!fresh.length) {
    const why = !sessions.length
      ? 'no finished Copilot CLI sessions on this machine yet'
      : !inWindow.length
        ? 'none of them started inside this cycle'
        : !spent.length
          ? 'the sessions in this cycle made no billable model calls'
          : 'every session in this cycle is already in the ledger';
    console.log(kv('added', c.dim(`nothing - ${why}`)));
  } else {
    console.log(
      kv(
        'added',
        `${c.bold(`${fmtNum(totals.sessions)} ${plural(totals.sessions, 'session')}`)} ${c.dim(
          `(${fmtNum(totals.aiu)} AI credits, ${fmtNum(totals.premiumRequests)} premium ${plural(totals.premiumRequests, 'request')})`,
        )}`,
      ),
    );
    if (totals.tokens) console.log(kv('tokens', `${fmtTokens(totals.tokens)} of conversation, read from the CLI's own record`));
    if (totals.unknownTurns) {
      console.log(
        kv(
          'turn counts',
          c.dim(`${totals.unknownTurns} ${plural(totals.unknownTurns, 'session')} did not record how many prompts it took`),
        ),
      );
    }
  }

  if (skipped.unfinished) {
    console.log(kv('skipped', c.dim(`${skipped.unfinished} session(s) still open or never shut down cleanly`)));
  }

  if (fresh.length) {
    console.log('');
    console.log(
      `  ${budgetBar(after.burn.credits, after.burn.allowance, 30)} ${c.bold(
        `${fmtNum(after.burn.credits)}${after.burn.allowance ? `/${fmtNum(after.burn.allowance)}` : ''}`,
      )} ${after.burn.allowance ? c.dim(fmtPct(after.burn.pctUsed)) : c.dim('credits')}`,
    );
    if (before.burn.credits !== after.burn.credits) {
      console.log(c.dim(`  was ${fmtNum(before.burn.credits)} before this harvest`));
    }
    console.log('');
    console.log(
      table(
        fresh.map((s) => [
          c.dim(s.startedAt.toISOString().slice(0, 10)),
          s.model || c.dim('-'),
          fmtNum(s.aiu),
          fmtNum(s.premiumRequests),
          s.turns == null ? c.dim('-') : fmtNum(s.turns),
          c.dim(fmtTokens(s.tokens.conversation)),
        ]),
        {
          head: ['day', 'model', 'AI credits', 'prem reqs', 'turns', 'tokens'],
          align: ['left', 'left', 'right', 'right', 'right', 'right'],
        },
      ),
    );
  }

  console.log('');
  if (dryRun) console.log(c.dim('  Nothing was written. Drop --dry-run to harvest.'));
  else if (fresh.length) console.log(c.dim('  Run this again any time - sessions are keyed by the CLI’s own id, so nothing doubles up.'));
  console.log('');
  return null;
}
