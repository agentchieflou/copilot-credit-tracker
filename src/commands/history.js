import { loadState, archiveIds, loadArchived } from '../core/state.js';
import { computeMetrics } from '../core/metrics.js';
import { c, fmtNum, fmtPct, table, heading, bar } from '../util/fmt.js';
import { asNumber } from '../util/args.js';

export function cmdHistory(flags, positionals, { json }) {
  const state = loadState();
  const limit = asNumber(flags.n ?? flags.limit, 12);

  const archived = archiveIds()
    .filter((id) => id !== state.period.id)
    .map((id) => loadArchived(id))
    .filter(Boolean);

  const periods = [...archived, state.period]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(-limit);

  const rows = periods.map((p) => ({
    period: p,
    metrics: computeMetrics(p, state.cfg, { table: state.table, now: p.id === state.period.id ? new Date() : new Date(p.end) }),
    live: p.id === state.period.id,
  }));

  if (json) {
    return rows.map((r) => ({ id: r.period.id, live: r.live, metrics: r.metrics }));
  }

  if (!rows.length) {
    console.log(c.dim('No history yet.'));
    return null;
  }

  console.log(heading('Cycle history'));
  const maxCredits = Math.max(...rows.map((r) => r.metrics.burn.credits), 1);
  console.log(
    table(
      rows.map(({ period, metrics, live }) => {
        const b = metrics.burn;
        return [
          live ? c.bold(`${period.id} *`) : period.id,
          bar(b.credits, maxCredits, 16),
          fmtNum(b.credits),
          b.allowance ? c.dim(`/${fmtNum(b.allowance)}`) : c.dim('-'),
          b.allowance ? fmtPct(b.pctUsed) : c.dim('-'),
          fmtNum(b.prompts),
          fmtNum(metrics.sessions.total),
          fmtNum(metrics.sessions.avgPrompts),
          fmtPct(metrics.sessions.singleRate),
          metrics.models[0] ? metrics.models[0].label : c.dim('-'),
          // A cycle that was largely backfilled has thin session columns for a
          // reason; say so rather than let it read as a quiet month.
          metrics.imported ? c.dim(`${fmtPct(metrics.imported.share)} backfilled`) : '',
        ];
      }),
      {
        head: ['cycle', '', 'credits', 'cap', 'used', 'prompts', 'sess', 'p/sess', '1-shot', 'top model', ''],
        align: ['left', 'left', 'right', 'left', 'right', 'right', 'right', 'right', 'right', 'left', 'left'],
      },
    ),
  );
  console.log(c.dim('  * live cycle, still accumulating.'));
  if (rows.some((r) => r.metrics.imported)) {
    console.log(c.dim('  prompts/sess/p-sess/1-shot cover logged prompts only; backfilled days have no shape.'));
  }

  if (rows.length >= 2) {
    const last = rows[rows.length - 1].metrics;
    const prior = rows[rows.length - 2].metrics;
    const move = last.burn.credits - prior.burn.credits;
    console.log('');
    console.log(
      `  ${move >= 0 ? c.red(`+${fmtNum(move)}`) : c.green(fmtNum(move))} credits vs ${
        rows[rows.length - 2].period.id
      }, one-shot rate ${fmtPct(prior.sessions.singleRate)} ${c.dim('->')} ${fmtPct(last.sessions.singleRate)}`,
    );
  }
  console.log('');
  return null;
}
