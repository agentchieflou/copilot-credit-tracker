/**
 * A tiny argv parser. node:util parseArgs needs every option declared up front,
 * which fights a CLI with per-command flags; this stays dependency-free and
 * lets each command read what it cares about.
 *
 * Supports: --key=value, --key value, --flag, --no-flag, -abc short clusters,
 * and `--` to end flag parsing.
 */
export function parseArgv(argv, { booleans = [], aliases = {} } = {}) {
  const flags = {};
  const positionals = [];
  const boolSet = new Set(booleans);

  const setFlag = (rawKey, value) => {
    const key = aliases[rawKey] || rawKey;
    if (key in flags) {
      flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
    } else {
      flags[key] = value;
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        setFlag(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith('no-')) {
        setFlag(body.slice(3), false);
        continue;
      }
      const next = argv[i + 1];
      const key = aliases[body] || body;
      if (boolSet.has(key) || next === undefined || (next.startsWith('-') && !/^-?\d/.test(next))) {
        setFlag(body, true);
      } else {
        setFlag(body, next);
        i += 1;
      }
      continue;
    }

    // -n 5 / -abc / negative numbers stay positional
    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const letters = arg.slice(1).split('');
      letters.forEach((letter, idx) => {
        const key = aliases[letter] || letter;
        const isLast = idx === letters.length - 1;
        const next = argv[i + 1];
        if (isLast && !boolSet.has(key) && next !== undefined && !next.startsWith('-')) {
          setFlag(letter, next);
          i += 1;
        } else {
          setFlag(letter, true);
        }
      });
      continue;
    }

    positionals.push(arg);
  }

  return { flags, positionals };
}

export function asNumber(value, fallback = null) {
  if (value === undefined || value === null || value === true || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asString(value, fallback = null) {
  if (typeof value === 'string' && value.length) return value;
  if (Array.isArray(value)) return asString(value[value.length - 1], fallback);
  return fallback;
}

export function asList(value) {
  if (value === undefined || value === null || value === true) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}
