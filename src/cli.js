import fs from 'node:fs';
import path from 'node:path';
import { parseArgv } from './util/args.js';
import { configureColor, c } from './util/fmt.js';
import { loadConfig } from './core/config.js';
import { packageRoot } from './core/paths.js';
import { cmdLog, cmdStart, cmdPrompt, cmdEnd, cmdUndo } from './commands/log.js';
import { cmdStatus } from './commands/status.js';
import { cmdReport } from './commands/report.js';
import { cmdHistory } from './commands/history.js';
import { cmdModels } from './commands/models.js';
import { cmdConfig, cmdInit } from './commands/config.js';
import { cmdSync } from './commands/sync.js';
import { cmdImport } from './commands/import.js';
import { cmdExport } from './commands/export.js';

const BOOLEAN_FLAGS = [
  'json',
  'help',
  'version',
  'dry-run',
  'solo',
  'new',
  'close',
  'stdin',
  'solved',
  'partial',
  'wasted',
  'color',
  'all',
  'replace',
  'clear',
  'by-day',
  'import',
];

const ALIASES = {
  h: 'help',
  v: 'version',
  j: 'json',
  t: 'text',
  f: 'file',
  o: 'out',
};

const COMMANDS = {
  status: cmdStatus,
  st: cmdStatus,
  log: cmdLog,
  l: cmdLog,
  start: cmdStart,
  prompt: cmdPrompt,
  p: cmdPrompt,
  next: cmdPrompt,
  end: cmdEnd,
  e: cmdEnd,
  undo: cmdUndo,
  u: cmdUndo,
  report: cmdReport,
  r: cmdReport,
  history: cmdHistory,
  hist: cmdHistory,
  models: cmdModels,
  m: cmdModels,
  config: cmdConfig,
  cfg: cmdConfig,
  init: cmdInit,
  sync: cmdSync,
  import: cmdImport,
  backfill: cmdImport,
  pull: cmdImport,
  export: cmdExport,
};

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const HELP = `
${c.bold('ccred')} - GitHub Copilot credit tracker ${c.dim('(persists across sessions, resets with your billing cycle)')}

${c.bold('LOGGING')}
  ccred log <model> [note]        log one premium request; joins the open session if warm
  ccred start <model> [label]     open a session explicitly
  ccred p [note]                  log another prompt in the open session
  ccred end [--solved|--wasted]   close the open session
  ccred undo                      drop the last logged prompt

  ${c.dim('length:')}  --text "…"  --file prompt.md  --stdin  --chars N  --words N
  ${c.dim('tokens:')}  --in N  --out N  --ctx N
  ${c.dim('other:')}   --count N (requests in one prompt)  --multiplier N  --tag a,b  --solo

${c.bold('REPORTING')}
  ccred                           burn-rate summary for the live cycle
  ccred status                    same, explicitly
  ccred report [cycle]            full analysis: burn, session shape, models, length, tokens
  ccred history [-n 12]           every cycle side by side
  ccred export [cycle] --format csv --out file.csv

  ${c.dim('cycle:')}  a cycle id like 2026-07, or "current" / "last"

${c.bold('SETUP')}
  ccred init --plan pro --reset-day 14
  ccred config                    show settings
  ccred config set <key> <value>
  ccred config path               where the data lives
  ccred models                    multipliers and plan allowances
  ccred models --set claude-opus-4.1=10
  ccred sync [--scope personal|organization|enterprise] [--dry-run]

${c.bold('STARTING MID-CYCLE')}
  ccred import                    pull this month's spend from GitHub into the ledger
  ccred import --file usage.csv   ...or from a usage report you exported instead
  ccred import --dry-run          show what would be added, write nothing
  ccred import --replace          discard earlier backfills and re-pull
  ccred import --clear            remove backfilled entries, keep what you logged
  ccred import --by-day           list every day added, not just the model totals

  ${c.dim('Backfilled days count toward burn and per-model spend. They carry no session')}
  ${c.dim('shape or prompt length, because the billing data GitHub returns has neither.')}

${c.bold('GLOBAL')}
  --json     machine-readable output for any command
  --no-color plain text
  -h, --help / -v, --version

${c.dim('Data lives outside this repo (ccred config path) so it survives across shells and')}
${c.dim('terminals. Cycles roll over automatically on first use after your reset day, and')}
${c.dim('the finished cycle is archived intact.')}
`;

export async function run(argv = process.argv.slice(2)) {
  const { flags, positionals } = parseArgv(argv, { booleans: BOOLEAN_FLAGS, aliases: ALIASES });

  let colorMode = 'auto';
  try {
    colorMode = loadConfig().display?.color || 'auto';
  } catch {
    /* a broken config should not stop --help from rendering */
  }
  if (flags.color === false || process.env.NO_COLOR) colorMode = 'never';
  if (flags.color === true) colorMode = 'always';
  configureColor(colorMode);

  if (flags.version === true) {
    console.log(version());
    return 0;
  }

  const name = positionals.shift();

  if (!name && flags.help !== true) {
    await COMMANDS.status(flags, positionals, { json: flags.json === true });
    return 0;
  }
  if (flags.help === true || !name || name === 'help') {
    console.log(HELP);
    return 0;
  }
  if (name === 'where') {
    await cmdConfig(flags, ['path'], { json: flags.json === true });
    return 0;
  }

  const handler = COMMANDS[name];
  if (!handler) {
    const known = [...new Set(Object.keys(COMMANDS))].join(', ');
    throw new Error(`Unknown command "${name}". Known commands: ${known}`);
  }

  const json = flags.json === true;
  const result = await handler(flags, positionals, { json });
  if (json && result !== null && result !== undefined) {
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}

export async function main(argv) {
  try {
    process.exitCode = await run(argv);
  } catch (err) {
    const wantsJson = (argv || process.argv.slice(2)).includes('--json');
    if (wantsJson) console.log(JSON.stringify({ error: err.message }, null, 2));
    else console.error(`${c.red('error:')} ${err.message}`);
    process.exitCode = 1;
  }
}
