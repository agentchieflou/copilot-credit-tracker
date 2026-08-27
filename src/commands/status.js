import { loadState } from '../core/state.js';
import { computeMetrics } from '../core/metrics.js';
import { activeSession } from '../core/ledger.js';
import { c, fmtNum, fmtPct, fmtDate, budgetBar, kv, bar, table, plural } from '../util/fmt.js';
import { truncate } from '../util/text.js';

function paceText(burn) {
  if (burn.pace === 'n/a') return c.dim('no allowance set');
  const abs = fmtNum(Math.abs(burn.paceDelta));
  if (burn.pace === 'over') return c.red(`${abs} ahead of pace`);
  if (burn.pace === 'under') return c.green(`${abs} under pace`);
  return c.dim('on track');
}

export function cmdStatus(flags, positionals, { json }) {
  const state = loadState();
  const m = computeMetrics(state.period, state.cfg, { table: state.table });
  if (json) return m;

  const { burn, progress, sessions } = m;
  const open = activeSession(state.period);

  console.log('');
  console.log(
    `${c.bold(`Copilot credits - ${m.periodId}`)} ${c.dim(
      `(${m.plan}, ${fmtDate(progress.start)} to ${fmtDate(progress.end)})`,
    )}`,
  );
  if (state.rolled.length) {
    console.log(c.yellow(`  rolled over ${state.rolled.length} cycle(s): ${state.rolled.join(', ')} archived`));
  }
  console.log('');

  if (burn.allowance) {
    console.log(
      `  ${budgetBar(burn.credits, burn.allowance, 30)} ${c.bold(
        `${fmtNum(burn.credits)}/${fmtNum(burn.allowance)}`,
      )} ${c.dim(fmtPct(burn.pctUsed))}`,
    );
    console.log(
      `  ${c.dim(bar(progress.fraction, 1, 30))} ${c.dim(
        `${fmtPct(progress.fraction)} of the cycle elapsed, ${Math.round(progress.daysLeftWhole)}d left`,
      )}`,
    );
  } else {
    console.log(`  ${c.bold(fmtNum(burn.credits))} credits used ${c.dim('(no allowance configured)')}`);
  }

  console.log('');
  console.log(kv('pace', paceText(burn)));
  console.log(kv('burn rate', `${fmtNum(burn.perDay)} credits/day  ${c.dim(`over ${burn.activeDays} active ${plural(burn.activeDays, 'day')}`)}`));
  console.log(
    kv(
      'projected',
      `${fmtNum(burn.projected)} by ${fmtDate(progress.end)}${
        burn.allowance && burn.projected > burn.allowance
          ? c.red(`  (${fmtNum(burn.projected - burn.allowance)} over)`)
          : ''
      }`,
    ),
  );
  if (burn.safeDaily != null && !burn.complete) {
    console.log(kv('safe daily', `${fmtNum(burn.safeDaily)} credits/day to finish exactly on budget`));
  }
  if (burn.exhaustion) {
    console.log(kv('runs out', c.red(`${fmtDate(burn.exhaustion, { withTime: false })} at this rate`)));
  }
  console.log(
    kv(
      'sessions',
      sessions.total
        ? `${fmtNum(sessions.total)} ${c.dim(
            `(${fmtPct(sessions.singleRate)} one-prompt, ${fmtNum(sessions.avgPrompts)} prompts avg)`,
          )}`
        : c.dim('none logged yet'),
    ),
  );
  if (m.imported) {
    console.log(
      kv(
        'backfilled',
        `${fmtNum(m.imported.credits)} credits ${c.dim(
          `(${fmtPct(m.imported.share)} of the total, ${m.imported.days} ${plural(m.imported.days, 'day')} from ${m.imported.sources.join(', ') || 'an import'})`,
        )}`,
      ),
    );
  }

  const top = m.models.slice(0, 3);
  if (top.length) {
    console.log('');
    console.log(
      table(
        top.map((mod) => [
          mod.label,
          c.dim(`x${mod.multiplier}`),
          `${fmtNum(mod.credits)} cr`,
          c.dim(`${fmtPct(mod.share)}`),
          c.dim(`${fmtNum(mod.requests)} ${plural(mod.requests, 'request')}`),
        ]),
        { align: ['left', 'left', 'right', 'right', 'right'] },
      ),
    );
  }

  if (open) {
    const spent = open.prompts.reduce((a, p) => a + p.credits + (p.tokenCredits || 0), 0);
    console.log('');
    console.log(
      `  ${c.yellow('open session')} ${c.bold(open.id)} - ${open.prompts.length} prompt(s), ${fmtNum(
        spent,
      )} credits${open.label ? c.dim(`  "${truncate(open.label, 40)}"`) : ''}`,
    );
  }

  if (m.sync) {
    const drift = m.sync.reported?.premiumRequests != null ? m.sync.reported.premiumRequests - burn.credits : null;
    console.log('');
    console.log(
      c.dim(
        `  GitHub reported ${fmtNum(m.sync.reported?.premiumRequests)} premium requests as of ${fmtDate(
          m.sync.at,
          { withTime: true },
        )}${drift != null ? ` (ledger is ${drift > 0 ? 'behind' : 'ahead'} by ${fmtNum(Math.abs(drift))})` : ''}`,
      ),
    );
  }

  if (!burn.prompts) {
    console.log('');
    if (!burn.entries) {
      console.log(c.dim('  Nothing here yet. Start from what you have already spent this cycle:'));
      console.log(c.dim('    ccred import                       pull it from GitHub'));
      console.log(c.dim('    ccred import --file usage.csv      ...or from an exported usage report'));
      console.log('');
    }
    console.log(c.dim('  Then log as you go:  ccred log sonnet "fixing the auth redirect"'));
  }
  console.log('');
  return null;
}
