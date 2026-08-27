import fs from 'node:fs';
import path from 'node:path';
import { loadState, resolvePeriod, archiveIds, loadArchived } from '../core/state.js';
import { computeMetrics } from '../core/metrics.js';
import { allPrompts } from '../core/ledger.js';
import { c } from '../util/fmt.js';
import { asString } from '../util/args.js';

const PROMPT_COLUMNS = [
  'period',
  'session_id',
  'session_label',
  'session_prompt_count',
  'session_outcome',
  'origin',
  'prompt_index',
  'timestamp',
  'model',
  'multiplier',
  'requests',
  'request_credits',
  'token_credits',
  'total_credits',
  'chars',
  'words',
  'tokens_input',
  'tokens_output',
  'tokens_context',
  'note',
];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function promptRows(period) {
  const rows = [];
  for (const session of period.sessions) {
    session.prompts.forEach((p, i) => {
      rows.push([
        period.id,
        session.id,
        session.label || '',
        session.prompts.length,
        session.outcome || '',
        p.origin || session.origin || 'logged',
        i + 1,
        p.at,
        p.model,
        p.multiplier,
        p.count,
        p.credits,
        p.tokenCredits || 0,
        (p.credits || 0) + (p.tokenCredits || 0),
        p.chars ?? '',
        p.words ?? '',
        p.tokens?.input ?? 0,
        p.tokens?.output ?? 0,
        p.tokens?.context ?? 0,
        p.note || '',
      ]);
    });
  }
  return rows;
}

export function cmdExport(flags, positionals, { json }) {
  const state = loadState();
  const ref = positionals[0] || asString(flags.period, 'current');
  const format = asString(flags.format, json ? 'json' : 'csv');

  let periods;
  if (ref === 'all') {
    periods = [
      ...archiveIds()
        .filter((id) => id !== state.period.id)
        .map((id) => loadArchived(id))
        .filter(Boolean),
      state.period,
    ].sort((a, b) => a.id.localeCompare(b.id));
  } else {
    const one = resolvePeriod(ref, state);
    if (!one) throw new Error(`No data for period "${ref}".`);
    periods = [one];
  }

  let payload;
  if (format === 'csv') {
    const lines = [PROMPT_COLUMNS.join(',')];
    for (const p of periods) for (const row of promptRows(p)) lines.push(row.map(csvCell).join(','));
    payload = `${lines.join('\n')}\n`;
  } else if (format === 'json') {
    payload = `${JSON.stringify(
      periods.map((p) => ({
        period: p,
        metrics: computeMetrics(p, state.cfg, { table: state.table }),
      })),
      null,
      2,
    )}\n`;
  } else if (format === 'ndjson') {
    payload = `${periods
      .flatMap((p) => allPrompts(p).map((prompt) => JSON.stringify({ period: p.id, ...prompt })))
      .join('\n')}\n`;
  } else {
    throw new Error(`Unknown --format "${format}". Use csv, json or ndjson.`);
  }

  const out = asString(flags.out ?? flags.o, null);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, payload, 'utf8');
    if (json) return { written: path.resolve(out), periods: periods.map((p) => p.id), format };
    console.log(`${c.green('wrote')} ${path.resolve(out)} ${c.dim(`(${format}, ${periods.length} cycle(s))`)}`);
    return null;
  }

  process.stdout.write(payload);
  return null;
}
