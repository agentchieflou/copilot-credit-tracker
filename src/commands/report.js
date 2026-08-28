import { loadState, resolvePeriod, archiveIds, loadArchived } from '../core/state.js';
import { computeMetrics, compareMetrics } from '../core/metrics.js';
import {
  c,
  fmtNum,
  fmtPct,
  fmtTokens,
  fmtDate,
  fmtDuration,
  table,
  heading,
  kv,
  bar,
  budgetBar,
  delta,
  plural,
} from '../util/fmt.js';
import { asString } from '../util/args.js';

function previousPeriodOf(periodId, state) {
  const ids = archiveIds().filter((id) => id < periodId);
  if (!ids.length) return null;
  return loadArchived(ids[ids.length - 1]);
}

export function cmdReport(flags, positionals, { json }) {
  const state = loadState();
  const ref = positionals[0] || asString(flags.period ?? flags.month, null);
  const period = resolvePeriod(ref, state);
  if (!period) throw new Error(`No data for period "${ref}". Run \`ccred history\` to see what is stored.`);

  const m = computeMetrics(period, state.cfg, { table: state.table });
  const prev = previousPeriodOf(period.id, state);
  const cmp = prev ? compareMetrics(m, computeMetrics(prev, state.cfg, { table: state.table })) : null;

  if (json) return { ...m, comparedWith: prev?.id || null, comparison: cmp };

  const { burn, sessions, progress, promptLength, tokens } = m;

  // ---- 1. burn rate --------------------------------------------------------
  console.log(heading(`Credit burn - ${m.periodId} (${m.plan})`));
  console.log(
    `  ${budgetBar(burn.credits, burn.allowance, 30)} ${c.bold(
      `${fmtNum(burn.credits)}${burn.allowance ? `/${fmtNum(burn.allowance)}` : ''}`,
    )} ${burn.allowance ? c.dim(fmtPct(burn.pctUsed)) : c.dim('credits')}`,
  );
  console.log('');
  console.log(kv('window', `${fmtDate(progress.start)} - ${fmtDate(progress.end)}  ${c.dim(`${Math.round(progress.daysTotal)} days`)}`));
  console.log(
    kv(
      'requests',
      `${fmtNum(burn.requests)} premium ${plural(burn.requests, 'request')}  ${c.dim(
        m.imported
          ? `(${fmtNum(burn.loggedCredits)} credits logged + ${fmtNum(burn.importedCredits)} backfilled)`
          : `over ${fmtNum(burn.prompts)} logged ${plural(burn.prompts, 'prompt')}`,
      )}`,
    ),
  );
  if (burn.tokenCredits > 0) {
    console.log(kv('credit split', `${fmtNum(burn.requestCredits)} from requests + ${fmtNum(burn.tokenCredits)} from tokens`));
  }
  console.log(
    kv('burn rate', `${fmtNum(burn.perDay)} / day  ${c.dim(`(${burn.activeDays} active ${plural(burn.activeDays, 'day')})`)}`),
  );
  if (!burn.complete) {
    console.log(kv('projected', fmtNum(burn.projected)));
    if (burn.safeDaily != null) {
      console.log(kv('safe daily', `${fmtNum(burn.safeDaily)} for the ${Math.round(progress.daysLeftWhole)} days left`));
    }
  } else if (burn.allowance) {
    console.log(kv('finished', `${fmtNum(burn.remaining)} credits unused ${c.dim(`(${fmtPct(1 - burn.pctUsed)} of the cap)`)}`));
  }
  if (burn.busiestDay) console.log(kv('busiest day', `${burn.busiestDay.date} - ${fmtNum(burn.busiestDay.credits)} credits`));
  if (cmp) console.log(kv('vs last cycle', `${delta(cmp.credits, { good: 'down' })} credits ${c.dim(`(${prev.id})`)}`));

  if (m.daily.length) {
    const max = Math.max(...m.daily.map((d) => d.credits));
    console.log('');
    console.log(
      table(
        m.daily.map((d) => [
          c.dim(d.date),
          bar(d.credits, max, 22),
          fmtNum(d.credits),
          c.dim(d.prompts ? `${d.prompts}p` : ''),
          d.opening ? c.dim('opening balance') : d.imported ? c.dim('backfilled') : '',
        ]),
        { align: ['left', 'left', 'right', 'right', 'left'] },
      ),
    );
  }

  // ---- 2. session shape ----------------------------------------------------
  console.log(heading('Session shape - one prompt or many?'));
  if (!sessions.total) {
    console.log(c.dim('  No sessions logged.'));
  } else {
    console.log(
      kv(
        'one-and-done',
        `${fmtNum(sessions.single)} of ${fmtNum(sessions.total)} sessions ${c.dim(
          `(${fmtPct(sessions.singleRate)})`,
        )}`,
      ),
    );
    console.log(kv('multi-prompt', `${fmtNum(sessions.multi)} sessions, ${fmtNum(sessions.avgPrompts)} prompts avg, ${fmtNum(sessions.maxPrompts)} worst`));
    console.log(
      kv(
        're-prompt tax',
        `${fmtNum(sessions.followUpCredits)} credits ${c.dim(
          `(${fmtPct(sessions.followUpShare)} of spend went to follow-ups)`,
        )}`,
      ),
    );
    console.log(kv('per session', `${fmtNum(sessions.avgCreditsPerSession)} credits, ${fmtDuration(sessions.avgDurationMin)} avg`));
    if (cmp) console.log(kv('vs last cycle', `${delta(cmp.avgPrompts, { good: 'down' })} prompts/session`));
    console.log('');
    const maxCount = Math.max(...sessions.distribution.map((d) => d.count), 1);
    console.log(
      table(
        sessions.distribution.map((d) => [
          d.label,
          bar(d.count, maxCount, 18),
          fmtNum(d.count),
          c.dim(fmtPct(d.share)),
          `${fmtNum(d.credits)} cr`,
        ]),
        { head: ['session size', '', 'n', 'share', 'credits'], align: ['left', 'left', 'right', 'right', 'right'] },
      ),
    );
  }

  // ---- 3. per model --------------------------------------------------------
  console.log(heading('By model'));
  if (!m.models.length) {
    console.log(c.dim('  Nothing logged.'));
  } else {
    console.log(
      table(
        m.models.map((mod) => [
          mod.label,
          c.dim(`x${mod.multiplier}`),
          fmtNum(mod.credits),
          c.dim(fmtPct(mod.share)),
          fmtNum(mod.requests),
          ...(mod.soleSessions
            ? [fmtNum(mod.soleSessions), fmtNum(mod.avgPromptsPerSession), fmtPct(mod.singleRate), fmtNum(mod.creditsPerSession)]
            : [c.dim('-'), c.dim('-'), c.dim('-'), c.dim('-')]),
          mod.avgChars == null ? c.dim('-') : fmtNum(mod.avgChars),
        ]),
        {
          head: ['model', 'mult', 'credits', 'share', 'reqs', 'sess', 'p/sess', '1-shot', 'cr/sess', 'avg ch'],
          align: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
        },
      ),
    );
    console.log(
      c.dim('  sess/p-sess/1-shot/cr-sess count only sessions run entirely on that model.'),
    );
    const ranked = m.models.filter((mod) => mod.soleSessions >= 2).sort((a, b) => a.creditsPerSession - b.creditsPerSession);
    if (ranked.length >= 2) {
      const best = ranked[0];
      const worst = ranked[ranked.length - 1];
      console.log('');
      console.log(
        `  ${c.green('cheapest to finish with')}: ${c.bold(best.label)} at ${fmtNum(
          best.creditsPerSession,
        )} credits/session ${c.dim(`(${fmtNum(best.avgPromptsPerSession)} prompts)`)}`,
      );
      console.log(
        `  ${c.red('most expensive')}: ${c.bold(worst.label)} at ${fmtNum(
          worst.creditsPerSession,
        )} credits/session ${c.dim(`(${fmtNum(worst.avgPromptsPerSession)} prompts)`)}`,
      );
    }
  }

  // ---- 4. prompt length ----------------------------------------------------
  console.log(heading('Prompt length'));
  if (!promptLength.counted) {
    console.log(
      c.dim('  No prompt lengths captured. Add --text "…", --file path, --stdin, or --chars N when logging.'),
    );
  } else {
    console.log(
      kv('measured', `${fmtNum(promptLength.counted)} of ${fmtNum(burn.prompts)} prompts ${c.dim(`(${fmtPct(promptLength.coverage)})`)}`),
    );
    console.log(kv('avg / median', `${fmtNum(promptLength.avgChars)} / ${fmtNum(promptLength.medianChars)} chars  ${c.dim(`p90 ${fmtNum(promptLength.p90Chars)}`)}`));
    console.log(kv('avg words', fmtNum(promptLength.avgWords)));
    if (cmp) console.log(kv('vs last cycle', `${delta(cmp.avgChars, { good: 'up', decimals: 0 })} chars`));
    console.log('');
    console.log(
      table(
        promptLength.buckets.map((b) => [
          b.label,
          fmtNum(b.prompts),
          `${fmtNum(b.credits)} cr`,
          fmtNum(b.openerSessions),
          fmtNum(b.avgFollowUps),
          fmtNum(b.avgSessionCredits),
        ]),
        {
          head: ['opening prompt', 'prompts', 'credits', 'sessions', 'follow-ups', 'cr/sess'],
          align: ['left', 'right', 'right', 'right', 'right', 'right'],
        },
      ),
    );
    console.log(c.dim('  follow-ups = extra prompts a session needed after an opener of that length.'));
  }

  // ---- 5. tokens -----------------------------------------------------------
  console.log(heading('Token volume'));
  if (!tokens.tracked) {
    console.log(c.dim('  No token counts captured. Add --in N --out N --ctx N when logging.'));
  } else {
    console.log(kv('coverage', `${fmtNum(tokens.tracked)} prompts ${c.dim(`(${fmtPct(tokens.coverage)})`)}`));
    console.log(
      table(
        [
          ['input', fmtTokens(tokens.input), fmtTokens(tokens.perPrompt.input)],
          ['output', fmtTokens(tokens.output), fmtTokens(tokens.perPrompt.output)],
          ['context', fmtTokens(tokens.context), fmtTokens(tokens.perPrompt.context)],
        ],
        { head: ['dimension', 'total', 'per prompt'], align: ['left', 'right', 'right'] },
      ),
    );
    console.log(kv('output:input', `${fmtNum(tokens.ioRatio)}x`));
    const byModel = m.models.filter((mod) => mod.tokens.input + mod.tokens.output > 0);
    if (byModel.length) {
      console.log('');
      console.log(
        table(
          byModel.map((mod) => [
            mod.label,
            fmtTokens(mod.tokens.input),
            fmtTokens(mod.tokens.output),
            fmtTokens(mod.tokens.context),
            fmtTokens(mod.tokensPerCredit),
          ]),
          { head: ['model', 'in', 'out', 'ctx', 'tok/credit'], align: ['left', 'right', 'right', 'right', 'right'] },
        ),
      );
    }
  }

  if (m.outcomes) {
    console.log(heading('Outcomes'));
    console.log(
      kv(
        'rated sessions',
        `${m.outcomes.rated}  ${c.green(`${m.outcomes.solved} solved`)} / ${c.yellow(
          `${m.outcomes.partial} partial`,
        )} / ${c.red(`${m.outcomes.wasted} wasted`)}`,
      ),
    );
    console.log(kv('credits/solved', fmtNum(m.outcomes.creditsPerSolved)));
    console.log(kv('dead ends', c.red(`${fmtNum(m.outcomes.wastedCredits)} credits`)));
  }

  if (m.imported) {
    console.log(heading('Backfilled from billing data'));
    console.log(
      kv(
        'imported',
        `${fmtNum(m.imported.credits)} credits ${c.dim(
          `(${fmtPct(m.imported.share)} of this cycle, ${fmtNum(m.imported.requests)} premium ${plural(
            m.imported.requests,
            'request',
          )})`,
        )}`,
      ),
    );
    console.log(kv('covering', `${m.imported.days} ${plural(m.imported.days, 'day')}, ${m.imported.firstDay} to ${m.imported.lastDay}`));
    if (m.imported.opening > 0) {
      console.log(
        kv('opening balance', `${fmtNum(m.imported.opening)} credits entered by hand, dated to the start of the cycle`),
      );
    }
    console.log(kv('source', `${m.imported.sources.join(', ') || 'unknown'}${m.imported.at ? c.dim(`  at ${fmtDate(m.imported.at, { withTime: true })}`) : ''}`));
    if (m.imported.unattributed > 0) {
      console.log(kv('unattributed', c.yellow(`${fmtNum(m.imported.unattributed)} credits with no model named in the SKU`)));
    }
    console.log('');
    console.log(c.dim('  These days count toward burn, daily shape and per-model spend. They are left out'));
    console.log(c.dim('  of session shape and prompt length above: billing data records neither.'));
  }

  if (m.sync) {
    console.log(heading('GitHub reconciliation'));
    console.log(kv('scope', `${m.sync.scope}${m.sync.target ? ` (${m.sync.target})` : ''}`));
    console.log(kv('synced at', fmtDate(m.sync.at, { withTime: true })));
    console.log(kv('reported', `${fmtNum(m.sync.reported?.premiumRequests)} premium requests`));
    const driftVal = (m.sync.reported?.premiumRequests ?? 0) - burn.credits;
    console.log(kv('ledger drift', `${driftVal > 0 ? c.yellow(`+${fmtNum(driftVal)} unlogged`) : c.green(fmtNum(driftVal))}`));
  }

  console.log('');
  return null;
}
