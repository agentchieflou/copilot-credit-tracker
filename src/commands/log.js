import { loadState, savePeriod } from '../core/state.js';
import { resolveModel, saveModelOverride, loadModelTable, round4 } from '../core/models.js';
import {
  recordPrompt,
  startSession,
  closeSession,
  activeSession,
  undoLastPrompt,
  allPrompts,
} from '../core/ledger.js';
import { computeMetrics } from '../core/metrics.js';
import { measurePrompt } from '../util/text.js';
import { asNumber, asString, asList } from '../util/args.js';
import { c, fmtNum, fmtPct, budgetBar, plural } from '../util/fmt.js';
import { truncate } from '../util/text.js';

const OUTCOMES = ['solved', 'partial', 'wasted'];

function pickOutcome(flags) {
  for (const o of OUTCOMES) if (flags[o] === true) return o;
  const explicit = asString(flags.outcome, null);
  if (explicit && OUTCOMES.includes(explicit)) return explicit;
  if (explicit) throw new Error(`Unknown outcome "${explicit}". Use one of: ${OUTCOMES.join(', ')}.`);
  return null;
}

function tokensFrom(flags) {
  return {
    input: asNumber(flags.in ?? flags.input, 0) || 0,
    output: asNumber(flags.out ?? flags.output, 0) || 0,
    context: asNumber(flags.ctx ?? flags.context, 0) || 0,
  };
}

/**
 * Let an unknown model be logged in one step when the user supplies its
 * multiplier, instead of forcing a separate `ccred models --set` first.
 */
function resolveOrRegister(input, flags) {
  const table = loadModelTable();
  const explicitMultiplier = asNumber(flags.multiplier, null);
  try {
    return { model: resolveModel(input, table), table, registered: false };
  } catch (err) {
    if (explicitMultiplier == null) throw err;
    saveModelOverride(input, { multiplier: explicitMultiplier, label: input, vendor: 'custom' });
    const refreshed = loadModelTable();
    return { model: resolveModel(input, refreshed), table: refreshed, registered: true };
  }
}

function budgetLine(period, cfg, table) {
  const m = computeMetrics(period, cfg, { table });
  const { credits, allowance, remaining, pace } = m.burn;
  if (!allowance) return c.dim(`  ${fmtNum(credits)} credits used this cycle`);
  const paceTag =
    pace === 'over' ? c.red('over pace') : pace === 'under' ? c.green('under pace') : c.dim('on track');
  return `  ${budgetBar(credits, allowance, 24)} ${fmtNum(credits)}/${fmtNum(allowance)} ${c.dim(
    `(${fmtPct(credits / allowance)} used, ${fmtNum(remaining)} left,`,
  )} ${paceTag}${c.dim(')')}`;
}

export async function cmdLog(flags, positionals, { json }) {
  const state = loadState();
  const modelInput = positionals[0];
  if (!modelInput) throw new Error('Usage: ccred log <model> [note]   (run `ccred models` to see ids)');

  const { model, table, registered } = resolveOrRegister(modelInput, flags);
  const note = positionals.slice(1).join(' ') || asString(flags.note, null);
  const length = await measurePrompt(flags);

  if (flags.solo === true || flags.new === true) {
    const open = activeSession(state.period);
    if (open) closeSession(open, { reason: 'superseded' });
  }

  const { session, prompt, startedNew } = recordPrompt(state.period, state.cfg, {
    model,
    note,
    label: asString(flags.label, null) || note,
    tags: asList(flags.tag),
    count: asNumber(flags.count, 1) || 1,
    multiplier: asNumber(flags.multiplier, null),
    chars: length.chars,
    words: length.words,
    tokens: tokensFrom(flags),
  });

  if (flags.solo === true || flags.close === true) closeSession(session, { outcome: pickOutcome(flags) });
  savePeriod(state.period);

  if (json) {
    return { ok: true, prompt, session: { id: session.id, prompts: session.prompts.length }, registered };
  }

  const nth = session.prompts.length;
  const where = startedNew
    ? c.dim('new session')
    : c.yellow(`follow-up #${nth - 1} in session ${session.id}`);
  const cost = prompt.credits + prompt.tokenCredits;
  console.log(
    `${c.green('logged')} ${c.bold(model.label)} ${c.dim(`x${prompt.multiplier}`)} = ${c.bold(
      `${fmtNum(cost)} ${plural(cost, 'credit')}`,
    )}  ${where}`,
  );
  if (registered) console.log(c.yellow(`  registered new model "${model.id}" at x${model.multiplier}`));
  if (note) console.log(c.dim(`  "${truncate(note, 60)}"`));
  if (length.chars != null) {
    const words = length.words != null ? ` / ${fmtNum(length.words)} words` : '';
    console.log(c.dim(`  prompt length: ${fmtNum(length.chars)} chars${words}`));
  }
  console.log(budgetLine(state.period, state.cfg, table));
  return null;
}

export async function cmdStart(flags, positionals, { json }) {
  const state = loadState();
  const modelInput = positionals[0];
  if (!modelInput) throw new Error('Usage: ccred start <model> [label]');
  const { model } = resolveOrRegister(modelInput, flags);
  const label = positionals.slice(1).join(' ') || asString(flags.label, null);

  const open = activeSession(state.period);
  if (open) closeSession(open, { reason: 'superseded-by-start' });

  const session = startSession(state.period, { model, label, tags: asList(flags.tag) });
  savePeriod(state.period);

  if (json) return { ok: true, session };
  console.log(
    `${c.green('session open')} ${c.bold(session.id)} on ${c.bold(model.label)} ${c.dim(`x${model.multiplier}`)}`,
  );
  if (label) console.log(c.dim(`  "${truncate(label, 60)}"`));
  console.log(c.dim('  log each prompt with `ccred p [note]`, finish with `ccred end`'));
  return null;
}

export async function cmdPrompt(flags, positionals, { json }) {
  const state = loadState();
  const open = activeSession(state.period);
  const prompts = allPrompts(state.period);

  let modelInput = asString(flags.model ?? flags.m, null);
  if (!modelInput) {
    const fallback = open?.model || prompts[prompts.length - 1]?.model;
    if (!fallback) {
      throw new Error('No open session and no history to infer a model from. Use `ccred log <model> [note]`.');
    }
    modelInput = fallback;
  }

  const { model, table } = resolveOrRegister(modelInput, flags);
  const note = positionals.join(' ') || asString(flags.note, null);
  const length = await measurePrompt(flags);

  const { session, prompt, startedNew } = recordPrompt(state.period, state.cfg, {
    model,
    note,
    count: asNumber(flags.count, 1) || 1,
    multiplier: asNumber(flags.multiplier, null),
    chars: length.chars,
    words: length.words,
    tokens: tokensFrom(flags),
  });
  savePeriod(state.period);

  if (json) return { ok: true, prompt, session: { id: session.id, prompts: session.prompts.length } };

  const nth = session.prompts.length;
  const promptCost = prompt.credits + prompt.tokenCredits;
  console.log(
    `${c.green('logged')} prompt ${c.bold(`#${nth}`)} on ${c.bold(model.label)} ${c.dim(
      `x${prompt.multiplier}`,
    )} = ${fmtNum(promptCost)} ${plural(promptCost, 'credit')}${startedNew ? c.dim(' (new session)') : ''}`,
  );
  if (nth >= 4) {
    console.log(
      c.yellow(
        `  ${nth} prompts in this session so far - ${fmtNum(
          session.prompts.reduce((a, p) => a + p.credits + p.tokenCredits, 0),
        )} credits spent on it`,
      ),
    );
  }
  console.log(budgetLine(state.period, state.cfg, table));
  return null;
}

export async function cmdEnd(flags, positionals, { json }) {
  const state = loadState();
  const open = activeSession(state.period);
  if (!open) {
    if (json) return { ok: false, reason: 'no-open-session' };
    console.log(c.dim('No open session.'));
    return null;
  }
  const outcome = pickOutcome(flags);
  const note = positionals.join(' ');
  if (note) open.label = open.label ? `${open.label} - ${note}` : note;
  closeSession(open, { outcome });
  savePeriod(state.period);

  const spent = round4(open.prompts.reduce((a, p) => a + p.credits + (p.tokenCredits || 0), 0));
  if (json) return { ok: true, session: open, credits: spent };

  console.log(
    `${c.green('session closed')} ${c.bold(open.id)} - ${open.prompts.length} ${plural(
      open.prompts.length,
      'prompt',
    )}, ${c.bold(`${fmtNum(spent)} ${plural(spent, 'credit')}`)}${outcome ? c.dim(` (${outcome})`) : ''}`,
  );
  return null;
}

export async function cmdUndo(flags, positionals, { json }) {
  const state = loadState();
  const removed = undoLastPrompt(state.period);
  if (!removed) {
    if (json) return { ok: false, reason: 'nothing-to-undo' };
    console.log(c.dim('Nothing to undo in the current cycle.'));
    return null;
  }
  savePeriod(state.period);
  if (json) return { ok: true, removed: removed.prompt, removedSession: removed.removedSession };
  console.log(
    `${c.yellow('removed')} ${removed.prompt.model} prompt worth ${fmtNum(
      removed.prompt.credits + removed.prompt.tokenCredits,
    )} credits${removed.removedSession ? c.dim(' (its empty session went too)') : ''}`,
  );
  return null;
}
