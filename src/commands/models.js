import { loadModelTable, saveModelOverride, clearModelOverride } from '../core/models.js';
import { c, fmtNum, table, heading } from '../util/fmt.js';
import { asList, asString } from '../util/args.js';

export function cmdModels(flags, positionals, { json }) {
  const sets = asList(flags.set);
  const unsets = asList(flags.unset);
  const changes = [];

  for (const pair of sets) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`--set expects <model-id>=<multiplier>, got "${pair}"`);
    const id = pair.slice(0, eq).trim();
    const multiplier = Number(pair.slice(eq + 1));
    if (!Number.isFinite(multiplier) || multiplier < 0) {
      throw new Error(`Multiplier for "${id}" must be a number >= 0.`);
    }
    const label = asString(flags.label, null);
    saveModelOverride(id, { multiplier, ...(label ? { label } : {}) });
    changes.push(`set ${id} = x${multiplier}`);
  }
  for (const id of unsets) {
    changes.push(clearModelOverride(id) ? `cleared override for ${id}` : `no override for ${id}`);
  }

  const t = loadModelTable();

  if (json) return { asOf: t.asOf, overridden: t.overridden, models: t.models, plans: t.plans, changes };

  for (const change of changes) console.log(c.green(change));
  if (changes.length) console.log('');

  const filter = asString(positionals[0], null);
  const models = filter
    ? t.models.filter((m) => m.id.includes(filter.toLowerCase()) || m.vendor === filter.toLowerCase())
    : t.models;

  console.log(heading(`Premium request multipliers (bundled table as of ${t.asOf})`));
  console.log(
    table(
      [...models]
        .sort((a, b) => a.multiplier - b.multiplier || a.id.localeCompare(b.id))
        .map((m) => [
          m.id in (t.overridden || {}) ? c.yellow(`${m.id} *`) : m.id,
          c.dim(m.vendor || ''),
          `x${fmtNum(m.multiplier)}`,
          m.multiplier === 0 ? c.green('free') : '',
          c.dim((m.aliases || []).join(', ')),
        ]),
      { head: ['id', 'vendor', 'mult', '', 'aliases'], align: ['left', 'left', 'right', 'left', 'left'] },
    ),
  );
  console.log(c.dim('  * locally overridden.'));
  console.log('');
  console.log(c.dim('  GitHub changes these; verify against their premium-request docs and correct with:'));
  console.log(c.dim('    ccred models --set claude-opus-4.1=10'));
  console.log('');
  console.log(heading('Plans'));
  console.log(
    table(
      Object.entries(t.plans).map(([id, p]) => [id, p.label, `${fmtNum(p.allowance)} credits/mo`]),
      { align: ['left', 'left', 'right'] },
    ),
  );
  console.log('');
  return null;
}
